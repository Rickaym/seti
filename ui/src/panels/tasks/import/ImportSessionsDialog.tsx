import {
  IMPORT_BATCH_MAX,
  type ClaudeSession,
  type ImportSessionsInput,
  type Repo,
  type SessionImportResult,
  type Task,
} from '@seti/shared'
import { ArrowLeft, ChevronsDown, Import, ListChecks, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, errorText } from '@/api'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useTasks } from '@/hooks/useTasks'
import { useCurrentWorkspace } from '@/hooks/useWorkspaces'
import { cn } from '@/lib/utils'
import { ReviewStep } from '@/panels/tasks/import/ReviewStep'
import { SessionDetail } from '@/panels/tasks/import/SessionDetail'
import { SessionList } from '@/panels/tasks/import/SessionList'
import { draftIssue, importBody, type Drafts, type ImportDraft } from '@/panels/tasks/import/drafts'
import { useSessionDetails, useSessionSearch } from '@/panels/tasks/import/useSessions'

type Step = 'pick' | 'review'

const plural = (count: number, word: string) => `${String(count)} ${word}${count === 1 ? '' : 's'}`

function PickStep({
  query,
  setQuery,
  search,
  list,
  detail,
  detailShown,
  onBack,
}: {
  query: string
  setQuery: (query: string) => void
  search: ReturnType<typeof useSessionSearch>
  list: ReactNode
  detail: ReactNode
  /** A session is open; below md its detail then takes the list's place. */
  detailShown: boolean
  onBack: () => void
}) {
  const { rows, total, searching, loadingMore, loadMore } = search
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_26rem] max-md:grid-cols-1">
      <div
        className={cn('flex min-h-0 flex-col border-r border-border max-md:border-r-0', detailShown && 'max-md:hidden')}
      >
        <div className="space-y-1.5 border-b border-border p-3">
          <Input
            aria-label="Search sessions"
            placeholder="Search by title, folder or branch"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
            }}
          />
          <p className="text-2xs text-muted-foreground">
            Claude Code sessions from terminals and IDEs on this machine. Importing continues a copy; the original
            session stays as it is.
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows === null && <p className="p-4 text-xs text-muted-foreground">Loading sessions...</p>}
          {rows !== null && rows.length === 0 && (
            <p className="p-4 text-xs text-muted-foreground">
              {searching ? 'Searching...' : 'No sessions to import match.'}
            </p>
          )}
          {list}
          {rows !== null && rows.length < total && (
            <div className="p-3 text-center">
              <Button
                variant="outline"
                size="sm"
                aria-label={loadingMore ? undefined : `Load more sessions, ${String(total - rows.length)} left`}
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                <ChevronsDown />
                {loadingMore ? 'Loading...' : 'Load more'}
              </Button>
            </div>
          )}
        </div>
      </div>
      <div className={cn('flex min-h-0 flex-col', !detailShown && 'max-md:hidden')}>
        {detailShown && (
          <Button variant="ghost" size="sm" className="self-start md:hidden" onClick={onBack}>
            <ArrowLeft />
            Sessions
          </Button>
        )}
        <div className="min-h-0 flex-1">{detail}</div>
      </div>
    </div>
  )
}

/** Picks terminal sessions and imports the chosen few as tasks, one at a time or as a batch. */
export function ImportSessionsDialog({ onClose, onDone }: { onClose: () => void; onDone: (taskId: string) => void }) {
  const { refresh } = useTasks()
  const { currentId } = useCurrentWorkspace()
  const [query, setQuery] = useState('')
  const search = useSessionSearch(query)
  const [repos, setRepos] = useState<Repo[]>([])
  const [focused, setFocused] = useState<ClaudeSession | null>(null)
  const [checked, setChecked] = useState<ClaudeSession[]>([])
  const [drafts, setDrafts] = useState<Drafts>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [step, setStep] = useState<Step>('pick')
  const [importing, setImporting] = useState(false)
  const details = useSessionDetails([...(focused ? [focused.id] : []), ...checked.map((row) => row.id)])

  useEffect(() => {
    apiGet<Repo[]>('/repos')
      .then(setRepos)
      .catch((e: unknown) => toast.error(errorText(e)))
  }, [])

  const setDraft = (id: string, draft: ImportDraft) => {
    setDrafts((prev) => ({ ...prev, [id]: draft }))
    setErrors(({ [id]: _cleared, ...rest }) => rest)
  }

  const check = (row: ClaudeSession, on: boolean) => {
    setChecked((prev) => (on ? [...prev.filter((r) => r.id !== row.id), row] : prev.filter((r) => r.id !== row.id)))
  }

  const importOne = async (row: ClaudeSession) => {
    setImporting(true)
    try {
      const task = await apiPost<Task>(
        `/sessions/${row.id}/import`,
        importBody(details[row.id], drafts[row.id], currentId),
      )
      toast.success(`Imported "${task.title}"`)
      onDone(task.id)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setImporting(false)
    }
  }

  const importChecked = async () => {
    const body: ImportSessionsInput = {
      sessions: checked.map((row) => ({
        session_id: row.id,
        ...importBody(details[row.id], drafts[row.id], currentId),
      })),
    }
    setImporting(true)
    try {
      const results = await apiPost<SessionImportResult[]>('/sessions/import', body)
      const done = results.flatMap((r) => (r.task_id === null ? [] : [r.task_id]))
      const failed = Object.fromEntries(results.flatMap((r) => (r.error === null ? [] : [[r.session_id, r.error]])))
      if (done.length > 0) {
        toast.success(`Imported ${plural(done.length, 'session')}`)
        refresh()
      }
      const [first] = done
      if (Object.keys(failed).length === 0 && first !== undefined) {
        onDone(first)
        return
      }
      setChecked((prev) => prev.filter((row) => row.id in failed))
      setErrors(failed)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setImporting(false)
    }
  }

  const checkedIds = new Set(checked.map((row) => row.id))
  const blocked = checked.some((row) => draftIssue(row, drafts[row.id]) !== null)

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      <DialogContent className="flex h-[85vh] max-h-[92vh] min-h-0 flex-col gap-0 overflow-hidden border p-0 sm:max-w-5xl">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle>
            {step === 'pick' ? 'Import sessions' : `Review ${plural(checked.length, 'session')}`}
          </DialogTitle>
        </DialogHeader>
        {step === 'pick' ? (
          <PickStep
            query={query}
            setQuery={setQuery}
            search={search}
            detailShown={focused !== null}
            onBack={() => {
              setFocused(null)
            }}
            list={
              search.rows !== null && (
                <SessionList
                  rows={search.rows}
                  focusedId={focused?.id ?? null}
                  checkedIds={checkedIds}
                  canCheckMore={checked.length < IMPORT_BATCH_MAX}
                  onFocus={setFocused}
                  onCheck={check}
                />
              )
            }
            detail={
              focused ? (
                <ErrorBoundary name="This session" kind="inline" resetKey={focused.id}>
                  <SessionDetail
                    row={focused}
                    detail={details[focused.id]}
                    draft={drafts[focused.id]}
                    repos={repos}
                    importing={importing}
                    onChange={(draft) => {
                      setDraft(focused.id, draft)
                    }}
                    onImport={() => void importOne(focused)}
                  />
                </ErrorBoundary>
              ) : (
                <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
                  Select a session to see its details, or tick a few to import them together.
                </div>
              )
            }
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ErrorBoundary name="The review" kind="inline">
              <ReviewStep
                rows={checked}
                details={details}
                drafts={drafts}
                errors={errors}
                repos={repos}
                onChange={setDraft}
                onRemove={(id) => {
                  setChecked((prev) => prev.filter((row) => row.id !== id))
                }}
              />
            </ErrorBoundary>
          </div>
        )}
        <DialogFooter className="items-center border-t border-border px-4 py-3 sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {checked.length === 0
              ? `Tick up to ${String(IMPORT_BATCH_MAX)} sessions to import them together`
              : `${String(checked.length)} selected`}
          </span>
          <div className="flex gap-2">
            {step === 'pick' ? (
              <>
                <Button variant="outline" onClick={onClose}>
                  <X />
                  Cancel
                </Button>
                <Hint text="Check titles, folders and PRs of the ticked sessions before importing" side="top">
                  <Button
                    disabled={checked.length === 0}
                    onClick={() => {
                      setStep('review')
                    }}
                  >
                    <ListChecks />
                    Review
                  </Button>
                </Hint>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  onClick={() => {
                    setStep('pick')
                  }}
                >
                  <ArrowLeft />
                  Back
                </Button>
                <Button
                  aria-label={importing ? undefined : `Import ${plural(checked.length, 'session')}`}
                  disabled={checked.length === 0 || blocked || importing}
                  onClick={() => void importChecked()}
                >
                  <Import />
                  {importing ? 'Importing...' : `Import ${String(checked.length)}`}
                </Button>
              </>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
