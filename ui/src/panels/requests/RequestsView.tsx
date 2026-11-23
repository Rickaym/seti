import { requestCount, type PendingRequests } from '@seti/shared'
import { Inbox } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { refreshKnowledgeWaiting } from '@/hooks/useKnowledgeWaiting'
import { refreshRequests } from '@/hooks/useRequests'
import { useTasks } from '@/hooks/useTasks'
import { SubmitBar } from '@/panels/questions/QuestionsForm'
import { useAnswers } from '@/panels/questions/useAnswers'
import { KindFilterBar } from '@/panels/requests/KindFilter'
import { RequestGroupCard } from '@/panels/requests/RequestGroupCard'
import { kindCounts, kindsWaiting, requestGroups, type KindFilter } from '@/panels/requests/groups'

const unanswered = (requests: PendingRequests, gone: ReadonlySet<string>): PendingRequests => ({
  questions: requests.questions,
  access: requests.access.filter((request) => !gone.has(request.id)),
  permissions: requests.permissions.filter((request) => !gone.has(request.id)),
  notes: requests.notes.filter((note) => !gone.has(note.id)),
})

/** Calls `onEmpty` once the requests that showed are all settled, however that happened. */
function useRetract(count: number, onEmpty: (() => void) | undefined) {
  const seen = useRef(false)
  useEffect(() => {
    if (count > 0) {
      seen.current = true
    } else if (seen.current) {
      seen.current = false
      onEmpty?.()
    }
  }, [count, onEmpty])
}

interface RequestsViewProps {
  requests: PendingRequests
  /** The label of the button that sends every answered question. */
  submitLabel: string
  /** Leaves the agent header out of each group, as the drawer beside one agent does. */
  bare?: boolean
  /** Runs once everything that showed is answered, to go back or close. */
  onEmpty?: () => void
}

/**
 * Pending requests by agent, the ones that hold an agent up first, each answered in place, with
 * a filter by kind and one Submit all for the questions.
 */
export function RequestsView({ requests, submitLabel, bare = false, onEmpty }: RequestsViewProps) {
  const { tasks } = useTasks()
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set())
  const [filter, setFilter] = useState<KindFilter>('all')
  const shown = useMemo(() => unanswered(requests, gone), [requests, gone])
  const counts = kindCounts(shown)
  const kind = filter !== 'all' && counts[filter] === 0 ? 'all' : filter
  const groups = requestGroups(shown, kind)
  const answers = useAnswers(groups.flatMap((group) => group.questions))
  useRetract(requestCount(shown), onEmpty)
  const answered = (id: string) => {
    setGone((prev) => new Set([...prev, id]))
    refreshRequests()
    refreshKnowledgeWaiting()
  }
  return (
    <>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4 max-md:px-3 max-md:py-3">
        <KindFilterBar counts={counts} value={kind} onChange={setFilter} />
        {kindsWaiting(counts).length === 0 && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Inbox aria-hidden className="size-4" />
            Nothing waits on you. Agents ask here when they need you to decide or allow something.
          </p>
        )}
        {groups.map((group) => (
          <RequestGroupCard
            key={group.key}
            group={group}
            task={tasks.find((task) => task.id === group.taskId)}
            answers={answers}
            bare={bare}
            onAnswered={answered}
          />
        ))}
      </div>
      {(answers.total > 0 || answers.summary !== null) && <SubmitBar answers={answers} label={submitLabel} />}
    </>
  )
}
