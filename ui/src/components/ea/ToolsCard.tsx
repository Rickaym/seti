import { eaToolsAnswer, type EaTool, type EaToolGate } from '@seti/shared'
import { CircleHelp, Hand, Search, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { apiGetValid, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Input } from '@/components/ui/input'
import { SettingsCard } from '@/panels/settings/layout'
import { GATE_LABEL, countText, groupTools, matchTools } from './tool-list'

type Loaded =
  { status: 'loading' } | { status: 'error'; message: string } | { status: 'down' } | { status: 'ok'; tools: EaTool[] }

const GATE_HINT: Record<EaToolGate, string> = {
  runs: 'Runs when you ask',
  asks: 'Says what will happen and waits for your yes',
  word: 'Acts only on your own spoken or typed yes to that exact request',
}

const GATE_ICON: Partial<Record<EaToolGate, LucideIcon>> = { asks: CircleHelp, word: Hand }

function GateBadge({ gate }: { gate: EaToolGate }) {
  const Icon = GATE_ICON[gate]
  if (Icon === undefined) {
    return null
  }
  return (
    <Hint text={GATE_HINT[gate]}>
      <span className="inline-flex shrink-0 items-center gap-1 border border-border px-1.5 py-0.5 text-2xs text-muted-foreground">
        <Icon className="size-3" aria-hidden />
        {GATE_LABEL[gate]}
      </span>
    </Hint>
  )
}

function ToolRows({ tools }: { tools: EaTool[] }) {
  const groups = groupTools(tools)
  if (groups.length === 0) {
    return <p className="px-3 py-2 text-muted-foreground">No tool matches.</p>
  }
  return (
    <>
      {groups.map((group) => (
        <section key={group.area} aria-label={group.area} className="border-t border-border">
          <h4 className="bg-muted/40 px-3 py-1.5 font-medium">
            {group.area} <span className="text-muted-foreground">{String(group.tools.length)}</span>
          </h4>
          <ul>
            {group.tools.map((tool) => (
              <li key={tool.name} className="border-t border-border px-3 py-2">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 font-mono wrap-anywhere">{tool.name}</span>
                  <GateBadge gate={tool.gate} />
                </div>
                <p className="mt-0.5 text-muted-foreground">{tool.summary}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  )
}

function useEaTools(): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  useEffect(() => {
    const abort = new AbortController()
    apiGetValid('/ea/tools', eaToolsAnswer, abort.signal).then(
      (answer) => {
        setLoaded('tools' in answer ? { status: 'ok', tools: answer.tools } : { status: 'down' })
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

/** The running EA's tools, read only: what each does and whether it asks before it acts. */
export function ToolsCard() {
  const loaded = useEaTools()
  const [query, setQuery] = useState('')
  return (
    <SettingsCard title="Tools">
      <p className="border-b border-border px-3 py-2 text-muted-foreground">
        What the EA can do. Asks first: it says what will happen and waits for your yes. On your word: only your own
        spoken or typed yes to that exact request. The rest run when you ask. It has no tools for secret values,
        credentials, connections, share links or sign-in; those stay yours.
      </p>
      {loaded.status === 'loading' && <p className="px-3 py-2 text-muted-foreground">Loading...</p>}
      {loaded.status === 'down' && (
        <p className="px-3 py-2 text-muted-foreground">The EA is not running, so it cannot list its tools.</p>
      )}
      {loaded.status === 'error' && <p className="px-3 py-2 text-destructive">{loaded.message}</p>}
      {loaded.status === 'ok' && (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
            <div className="relative min-w-0 flex-1 basis-48">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search tools"
                placeholder="Search tools"
                className="pl-7"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                }}
              />
            </div>
            <span data-testid="ea-tools-count">{countText(loaded.tools)}</span>
          </div>
          <ToolRows tools={matchTools(loaded.tools, query)} />
        </>
      )}
    </SettingsCard>
  )
}
