import { highlightable, type CodeLanguage } from '@seti/shared'
import type { Segment } from '@seti/shared/highlight'
import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNearViewport } from '@/hooks/useNearViewport'
import { renderSegments } from './segments'

interface Highlighted {
  code: string
  language: CodeLanguage
  segments: Segment[]
}

/** Blocks highlighted lately, so a block that remounts shows its colours at once. */
const done = new Map<string, Highlighted>()
const CACHE_SIZE = 300

function remember(entry: Highlighted) {
  const key = `${entry.language}\n${entry.code}`
  done.delete(key)
  done.set(key, entry)
  if (done.size > CACHE_SIZE) {
    const [oldest] = done.keys()
    if (oldest !== undefined) {
      done.delete(oldest)
    }
  }
}

/** Highlighted runs for the code, with any text appended since the last highlight left plain. */
function renderRuns(code: string, from: Highlighted): ReactNode[] {
  const runs = renderSegments(from.segments)
  if (code.length > from.code.length) {
    runs.push(code.slice(from.code.length))
  }
  return runs
}

/** The highlight that still fits the code: an exact match, or one of text the code extends. */
function usable(code: string, language: CodeLanguage | null, from: Highlighted | null): Highlighted | null {
  if (language === null) {
    return null
  }
  const exact = done.get(`${language}\n${code}`)
  if (exact !== undefined) {
    return exact
  }
  return from !== null && from.language === language && code.startsWith(from.code) ? from : null
}

function CodeView({
  code,
  language,
  className,
}: {
  code: string
  /** The language to colour it as, or null to leave it plain. */
  language: CodeLanguage | null
  className?: string | undefined
}) {
  const ref = useRef<HTMLElement>(null)
  const [latest, setLatest] = useState<Highlighted | null>(null)
  const allowed = language !== null && highlightable(code)
  const shown = allowed ? usable(code, language, latest) : null
  const stale = allowed && shown?.code !== code
  const near = useNearViewport(ref, stale)
  useEffect(() => {
    if (!near || !stale) {
      return undefined
    }
    let live = true
    void import('@seti/shared/highlight')
      .then(async (m) => m.highlight(code, language))
      .then(
        (segments) => {
          const entry = { code, language, segments }
          remember(entry)
          if (live) {
            setLatest(entry)
          }
        },
        () => undefined,
      )
    return () => {
      live = false
    }
  }, [near, stale, code, language])
  return (
    // A fresh element for the colours, as React places many new siblings in quadratic time
    <code
      key={shown === null ? 'plain' : 'coloured'}
      ref={ref}
      className={className}
      data-language={language ?? undefined}
      data-highlighted={shown === null ? undefined : ''}
    >
      {shown === null ? code : renderRuns(code, shown)}
    </code>
  )
}

/**
 * Code as plain text first, then coloured once it nears the screen. The parser for its language
 * loads on demand, and code over the size limit or with a huge line stays plain.
 */
export const HighlightedCode = memo(CodeView)
