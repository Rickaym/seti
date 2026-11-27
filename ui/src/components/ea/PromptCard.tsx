import { eaPromptAnswer, type EaPromptPart } from '@seti/shared'
import { ChevronRight, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { apiGetValid, errorText } from '@/api'
import { CopyIconButton } from '@/components/CopyButton'
import { RelativeTime } from '@/components/RelativeTime'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { SettingsCard } from '@/panels/settings/layout'
import { chars, matchCount, partOpen, pieces, sizeText } from './prompt-parts'

type Loaded =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'down' }
  | { status: 'ok'; commit: string | null; parts: EaPromptPart[] }

function MarkedText({ text, query }: { text: string; query: string }) {
  return (
    <pre className="max-h-[60vh] overflow-y-auto border border-border bg-muted/30 p-2 font-mono text-2xs whitespace-pre-wrap wrap-anywhere">
      {pieces(text, query).map((piece) =>
        piece.match ? (
          <mark key={piece.from} className="bg-warning/30 text-inherit">
            {piece.text}
          </mark>
        ) : (
          piece.text
        ),
      )}
    </pre>
  )
}

function PartBody({ part, query }: { part: EaPromptPart; query: string }) {
  return (
    <div className="space-y-1.5 px-3 pb-3">
      <p className="text-muted-foreground">
        {part.about}
        {part.built_at !== null && (
          <>
            {' '}
            Sent <RelativeTime iso={part.built_at} />.
          </>
        )}
      </p>
      {part.text !== '' && (
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1">
            <MarkedText text={part.text} query={query} />
          </div>
          <CopyIconButton text={part.text} label={`Copy ${part.label.toLowerCase()}`} className="size-11" />
        </div>
      )}
    </div>
  )
}

function PartSection({ part, query, open, onToggle }: PartProps) {
  const found = query.trim() === '' ? null : matchCount(part.text, query)
  return (
    <Collapsible open={open} onOpenChange={onToggle} asChild>
      <section aria-label={part.label} className="border-t border-border">
        <CollapsibleTrigger className="group flex min-h-11 w-full items-center gap-2 px-3 text-left font-medium hover:bg-muted/40">
          <ChevronRight
            className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90"
            aria-hidden
          />
          <span className="min-w-0 flex-1">{part.label}</span>
          <span className="text-muted-foreground tabular-nums">
            {found === null ? chars(part.chars) : `${String(found)} found`}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <PartBody part={part} query={query} />
        </CollapsibleContent>
      </section>
    </Collapsible>
  )
}

interface PartProps {
  part: EaPromptPart
  query: string
  open: boolean
  onToggle: () => void
}

function PromptParts({ parts, query }: { parts: EaPromptPart[]; query: string }) {
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const toggle = (key: string) => {
    setOpened((now) => {
      const next = new Set(now)
      if (!next.delete(key)) {
        next.add(key)
      }
      return next
    })
  }
  return (
    <>
      {parts.map((part) => (
        <PartSection
          key={part.key}
          part={part}
          query={query}
          open={partOpen(part, query, opened)}
          onToggle={() => {
            toggle(part.key)
          }}
        />
      ))}
    </>
  )
}

function useEaPrompt(): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  useEffect(() => {
    const abort = new AbortController()
    apiGetValid('/ea/prompt', eaPromptAnswer, abort.signal).then(
      (answer) => {
        setLoaded('parts' in answer ? { status: 'ok', ...answer } : { status: 'down' })
      },
      (e: unknown) => {
        if (!abort.signal.aborted) {
          setLoaded({ status: 'error', message: errorText(e) })
        }
      },
    )
    return () => {
      abort.abort()
    }
  }, [])
  return loaded
}

/** The running EA's whole prompt, read only: its system prompt and what each turn adds. */
export function PromptCard() {
  const loaded = useEaPrompt()
  const [query, setQuery] = useState('')
  return (
    <SettingsCard title="Prompt">
      <p className="border-b border-border px-3 py-2 text-muted-foreground">
        What the EA&apos;s model is told. Read only: the prompt changes through code, measured in simulation.
      </p>
      {loaded.status === 'loading' && <p className="px-3 py-2 text-muted-foreground">Loading...</p>}
      {loaded.status === 'down' && (
        <p className="px-3 py-2 text-muted-foreground">The EA is not running, so it cannot show its prompt.</p>
      )}
      {loaded.status === 'error' && <p className="px-3 py-2 text-destructive">{loaded.message}</p>}
      {loaded.status === 'ok' && (
        <>
          <p data-testid="ea-prompt-size" className="px-3 pt-2">
            {sizeText(loaded.parts, loaded.commit)}
          </p>
          <div className="relative px-3 py-2">
            <Search className="pointer-events-none absolute top-1/2 left-5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              aria-label="Search prompt"
              placeholder="Search prompt"
              className="pl-7"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
              }}
            />
          </div>
          <PromptParts parts={loaded.parts} query={query} />
        </>
      )}
    </SettingsCard>
  )
}
