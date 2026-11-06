import type { Changelog } from '@seti/mod-api'
import { ListPlus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ChangelogList } from './ChangelogList'
import { RunningVersion, UpdateStatus } from './UpdateStatus'
import { errorText, useWhatsNew } from './mod-context'
import { useChangelog, useSetiUpdate } from './useChangelog'

const FIRST_LIMIT = 200
const LIMIT_MAX = 500

/** Opening the changelog marks the running version seen; the list keeps its marks for this visit. */
function useMarkSeen(log: Changelog | null) {
  const { api, status } = useWhatsNew()
  const marked = useRef<string | null>(null)
  const commit = log?.version?.commit ?? null
  const unseen = log?.unseen ?? 0
  useEffect(() => {
    if (commit === null || unseen === 0 || marked.current === commit) {
      return
    }
    marked.current = commit
    api
      .request('POST', '/seen', { commit })
      .then(status.refresh)
      .catch((e: unknown) => {
        api.kit.fail('Seti did not mark the changelog read', errorText(e))
      })
  }, [api, status, commit, unseen])
}

/** What changed in the running Seti, whether a newer one waits, and how to install it. */
export function WhatsNewBody() {
  const { ToggleButton } = useWhatsNew().api.kit
  const [all, setAll] = useState(false)
  const [limit, setLimit] = useState(FIRST_LIMIT)
  const { log, error } = useChangelog(limit)
  const update = useSetiUpdate()
  useMarkSeen(log)
  const version = log?.version ?? null
  return (
    <div className="space-y-3">
      <div className="space-y-3 border-b border-border pb-3">
        <p className="text-xs text-muted-foreground">
          {version === null ? 'Features and fixes in the Seti you run.' : <RunningVersion version={version} />}
        </p>
        {(version !== null || update?.state === 'unknown') && <UpdateStatus update={update} running={version} />}
      </div>
      <div id="changes" className="scroll-mt-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">Changes by day</span>
          <ToggleButton
            pressed={all}
            onPressedChange={setAll}
            icon={<ListPlus />}
            label="Upkeep"
            hint="Show upkeep too: chores, docs, tests, CI and dependency bumps"
          />
        </div>
        <ChangelogBody
          log={log}
          error={error}
          all={all}
          onMore={
            log?.has_more === true && limit < LIMIT_MAX
              ? () => {
                  setLimit(LIMIT_MAX)
                }
              : null
          }
        />
      </div>
    </div>
  )
}

function ChangelogBody({
  log,
  error,
  all,
  onMore,
}: {
  log: Changelog | null
  error: string
  all: boolean
  onMore: (() => void) | null
}) {
  if (error !== '') {
    return (
      <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
    )
  }
  if (log === null) {
    return <p className="text-sm text-muted-foreground">Loading...</p>
  }
  if (log.version === null) {
    return (
      <p className="border border-border bg-card p-6 text-sm text-muted-foreground">
        This Seti does not run from a git checkout, so it has no history to show.
      </p>
    )
  }
  return <ChangelogList log={log} all={all} onMore={onMore} />
}
