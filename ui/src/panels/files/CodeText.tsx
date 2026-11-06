import type { CodeLanguage } from '@seti/shared'
import type { CodeRange, Segment } from '@seti/shared/highlight'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { renderSegments } from '@/components/highlight/segments'
import { useNearViewport } from '@/hooks/useNearViewport'
import { cn } from '@/lib/utils'
import { MONO } from '@/panels/files/PlainText'
import { chunksOf, piecesOf, type LineChunk } from '@/panels/files/code-lines'

interface ChunkProps {
  text: string
  language: CodeLanguage
  chunk: LineChunk
  /** The line to mark, when it falls in this chunk. */
  line: number | undefined
  /** Width of the line number column, in characters. */
  digits: number
}

interface Coloured {
  text: string
  runs: Segment[][]
}

/** One run of lines with their numbers, coloured once it nears the screen. */
function CodeChunk({ text, language, chunk, line, digits }: ChunkProps) {
  const ref = useRef<HTMLDivElement>(null)
  const pieces = useMemo(() => piecesOf(text, chunk, line), [text, chunk, line])
  const [coloured, setColoured] = useState<Coloured | null>(null)
  const runs = coloured?.text === text ? coloured.runs : null
  const near = useNearViewport(ref, runs === null)
  useEffect(() => {
    if (!near || runs !== null) {
      return undefined
    }
    let live = true
    const ranges: CodeRange[] = pieces
    void import('@seti/shared/highlight')
      .then(async (m) => m.highlightRanges(text, language, ranges))
      .then(
        (next) => {
          if (live) {
            setColoured({ text, runs: next })
          }
        },
        () => undefined,
      )
    return () => {
      live = false
    }
  }, [near, runs, text, language, pieces])
  const numbers = Array.from({ length: chunk.count }, (_, n) => String(chunk.first + n)).join('\n')
  return (
    <div ref={ref} className="flex">
      <div
        aria-hidden
        data-line-numbers=""
        className="sticky left-0 shrink-0 bg-background pr-3 pl-4 text-right whitespace-pre text-muted-foreground tabular-nums select-none"
        style={{ minWidth: `calc(${String(digits)}ch + 1.75rem)` }}
      >
        {numbers}
      </div>
      <pre className="min-w-0 flex-1 pr-4 whitespace-pre">
        {/* A fresh element for the colours, as React places many new siblings in quadratic time */}
        <code
          key={runs === null ? 'plain' : 'coloured'}
          data-language={language}
          data-highlighted={runs === null ? undefined : ''}
        >
          {pieces.map((piece, n) => {
            const segments = runs?.[n]
            const body = segments === undefined ? text.slice(piece.from, piece.to) : renderSegments(segments)
            return piece.marked ? (
              <mark key={piece.from} data-line={line} className="bg-warning/30 text-inherit">
                {body}
              </mark>
            ) : (
              <Fragment key={piece.from}>{body}</Fragment>
            )
          })}
        </code>
      </pre>
    </div>
  )
}

/** A code file with line numbers, coloured a chunk of lines at a time as it scrolls into view. */
export function CodeText({
  text,
  language,
  line,
}: {
  text: string
  language: CodeLanguage
  /** The line to mark and scroll to, counted from 1. */
  line: number | undefined
}) {
  const box = useRef<HTMLDivElement>(null)
  const chunks = useMemo(() => chunksOf(text), [text])
  const last = chunks.at(-1)
  const digits = String(last === undefined ? 1 : last.first + last.count - 1).length
  useEffect(() => {
    box.current?.querySelector('mark[data-line]')?.scrollIntoView({ block: 'center' })
  }, [line, text])
  return (
    <div ref={box} data-code-file="" className="min-h-0 flex-1 overflow-auto py-3">
      <div className={cn(MONO, 'w-max min-w-full')}>
        {chunks.map((chunk) => (
          <CodeChunk
            key={chunk.first}
            text={text}
            language={language}
            chunk={chunk}
            line={line !== undefined && line >= chunk.first && line < chunk.first + chunk.count ? line : undefined}
            digits={digits}
          />
        ))}
      </div>
    </div>
  )
}
