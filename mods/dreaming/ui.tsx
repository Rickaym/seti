import {
  defineMod,
  type Disposer,
  type DreamNight,
  type DreamProposal,
  type DreamRun,
  type UiModApi,
} from '@seti/mod-api'
import { ChevronLeft, ChevronRight, Moon } from 'lucide-react'
import { useEffect, useState } from 'react'
import manifest from './seti-mod.json' with { type: 'json' }

const SHOWN_POLL_MS = 30_000

const SKIP_WORDS: Record<string, string> = {
  nothing_new: 'nothing new',
  opted_out: 'switched out',
  not_sandboxed: 'not sandboxed',
  no_memory: 'no memory folder',
}

const shift = (night: string, days: number) =>
  new Date(Date.parse(`${night}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

const dreamt = (run: DreamRun) => run.state === 'done' || run.state === 'stopped'

/** What wants the user: each ask of a dream and each clean-up waiting, with the agent to open. */
function WantsYou({ api, night, waiting }: { api: UiModApi; night: DreamNight; waiting: DreamProposal[] }) {
  const { Button } = api.kit
  const rows = [
    ...night.runs.flatMap((run) => (run.report?.asks ?? []).map((ask) => ({ task: run.task_id, text: ask }))),
    ...waiting.map((p) => ({ task: p.task_id, text: `Clean-up: ${p.kind.replace('_', ' ')} ${p.target}` })),
  ]
  if (rows.length === 0) {
    return null
  }
  return (
    <section aria-label="Wants you" className="space-y-1">
      <h2 className="text-xs font-semibold">Wants you</h2>
      {rows.map((row) => (
        <div
          key={`${row.task}:${row.text}`}
          className="flex items-center justify-between gap-2 border-b border-border py-1"
        >
          <span className="min-w-0 break-words text-xs">{row.text}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              api.agents.open(row.task)
            }}
          >
            Open
          </Button>
        </div>
      ))}
    </section>
  )
}

/** One row per agent that dreamt: what it tidied and remembered, its cost, and its report. */
function Agents({ api, runs }: { api: UiModApi; runs: DreamRun[] }) {
  const { Button } = api.kit
  const shown = runs.filter((run) => dreamt(run) || run.state === 'failed' || run.state === 'cut')
  if (shown.length === 0) {
    return null
  }
  return (
    <section aria-label="Agents" className="space-y-1">
      <h2 className="text-xs font-semibold">Agents</h2>
      {shown.map((run) => (
        <div key={run.id} className="flex items-center justify-between gap-2 border-b border-border py-1 text-xs">
          <span className="min-w-0">
            {run.report?.summary ?? run.reason ?? run.state}
            <span className="block text-muted-foreground">
              Tidied {String(run.report?.tidied.length ?? 0)}, remembered {String(run.report?.remembered.length ?? 0)},
              ${run.cost_usd.toFixed(2)}
            </span>
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              api.agents.open(run.task_id)
            }}
          >
            Open
          </Button>
        </div>
      ))}
    </section>
  )
}

function skippedLine(night: DreamNight): string {
  const counts: Record<string, number> = { ...night.skipped }
  for (const run of night.runs.filter((r) => r.state === 'skipped')) {
    const reason = run.reason?.replace(/\.$/, '') ?? 'skipped'
    counts[reason] = (counts[reason] ?? 0) + 1
  }
  const parts = Object.entries(counts).map(([reason, n]) => `${String(n)} ${SKIP_WORDS[reason] ?? reason}`)
  return parts.length === 0 ? '' : `Skipped: ${parts.join(', ')}`
}

const dreamsView = (api: UiModApi) =>
  function DreamsView() {
    const { Button } = api.kit
    const [asked, setAsked] = useState<string | undefined>(undefined)
    const [night, setNight] = useState<DreamNight | null | undefined>(undefined)
    const [waiting, setWaiting] = useState<DreamProposal[]>([])
    useEffect(() => {
      const query = asked === undefined ? '' : `?night=${asked}`
      Promise.all([
        api.request<DreamNight | null>('GET', `/night${query}`),
        api.request<DreamProposal[]>('GET', '/waiting'),
      ]).then(
        ([next, pending]) => {
          setNight(next)
          setWaiting(pending)
        },
        (e: unknown) => {
          api.kit.fail('Could not read the dreams', api.kit.errorText(e))
        },
      )
    }, [asked])
    const current = night?.night ?? asked
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-4 text-sm">
        <header className="flex items-center justify-between gap-2">
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <Moon className="size-4" />
            Dreams
          </h1>
          {current !== undefined && (
            <span className="flex items-center gap-1">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Night before"
                onClick={() => {
                  setAsked(shift(current, -1))
                }}
              >
                <ChevronLeft />
              </Button>
              <span className="text-xs tabular-nums">{current}</span>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Night after"
                onClick={() => {
                  setAsked(shift(current, 1))
                }}
              >
                <ChevronRight />
              </Button>
            </span>
          )}
        </header>
        {night === null && (
          <p className="text-muted-foreground">No dreams this night. Dreaming starts in Settings, Lifecycle.</p>
        )}
        {night?.state === 'missed' && <p className="text-muted-foreground">Seti was down for the whole window.</p>}
        {night !== null && night !== undefined && (
          <>
            <WantsYou api={api} night={night} waiting={waiting} />
            <Agents api={api} runs={night.runs} />
            <p className="text-xs text-muted-foreground">{skippedLine(night)}</p>
          </>
        )}
      </div>
    )
  }

/**
 * The Dreams view: what wants the user first, then each agent's dream, then who was left out. Its
 * sidebar entry shows only while Dreaming is on or once a dream has run.
 */
export const dreamingUi = defineMod({
  manifest,
  ui: (api) => {
    const shown = api.poll<{ shown: boolean }>('/shown', SHOWN_POLL_MS)
    const view = dreamsView(api)
    let section: Disposer | null = null
    const follow = () => {
      const on = shown.getSnapshot().data?.shown === true
      if (on && section === null) {
        section = api.registerSection({ id: 'dreams', icon: Moon, view })
      } else if (!on && section !== null) {
        section()
        section = null
      }
    }
    api.onDispose(shown.subscribe(follow))
  },
})
