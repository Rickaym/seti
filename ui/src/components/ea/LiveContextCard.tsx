import type { EaContext, EaIndexStatus } from '@seti/shared'
import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { apiGet, errorText } from '@/api'
import { Button } from '@/components/ui/button'
import { SettingRow, SettingsCard } from '@/panels/settings/layout'

type Loaded =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; context: EaContext; index: EaIndexStatus }

function indexText(index: EaIndexStatus): string {
  const search = index.vector && index.embeddings ? 'vector and full text' : 'full text only'
  return `${String(index.documents)} documents, ${String(index.embedded)} embedded; ${search}`
}

/** The live context the EA reads before each message, and the state of its search index. */
export function LiveContextCard() {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [round, setRound] = useState(0)

  useEffect(() => {
    let live = true
    Promise.all([apiGet<EaContext>('/ea/context'), apiGet<EaIndexStatus>('/ea/index')]).then(
      ([context, index]) => {
        if (live) {
          setLoaded({ status: 'ok', context, index })
        }
      },
      (e: unknown) => {
        if (live) {
          setLoaded({ status: 'error', message: errorText(e) })
        }
      },
    )
    return () => {
      live = false
    }
  }, [round])

  const refresh = (
    <Button
      variant="outline"
      size="xs"
      onClick={() => {
        setRound((n) => n + 1)
      }}
    >
      <RefreshCw />
      Refresh
    </Button>
  )
  return (
    <SettingsCard title="EA context" actions={refresh}>
      <p className="border-b border-border px-3 py-2 text-muted-foreground">
        Before each message the EA reads this snapshot, so status questions need no tool call. Asked what an agent
        decided or found, it also searches the index of what agents and PRs said.
      </p>
      {loaded.status === 'loading' && <p className="px-3 py-2 text-muted-foreground">Loading...</p>}
      {loaded.status === 'error' && <p className="px-3 py-2 text-destructive">{loaded.message}</p>}
      {loaded.status === 'ok' && (
        <>
          <SettingRow label="Snapshot" description="Rebuilt as agents and PRs change." stack>
            <span>
              {String(loaded.context.tokens)} tokens, as of {new Date(loaded.context.as_of).toLocaleTimeString()}
            </span>
          </SettingRow>
          <SettingRow
            label="Search index"
            description="Transcripts, subagent reports, PR descriptions and updates."
            stack
          >
            <span>{indexText(loaded.index)}</span>
          </SettingRow>
          <pre
            aria-label="Live context"
            className="max-h-96 overflow-auto px-3 py-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap"
          >
            {loaded.context.text}
          </pre>
        </>
      )}
    </SettingsCard>
  )
}
