import { listedStatus, type TaskListEntry } from '@seti/shared'
import { Lightbulb } from 'lucide-react'
import { agentColorAttr } from '@/lib/agent-color-sheet'
import { navigate } from '@/lib/route'
import { KnowledgeCard } from '@/panels/knowledge/KnowledgeCard'
import { AgentQuestions } from '@/panels/questions/QuestionsForm'
import type { Answers } from '@/panels/questions/useAnswers'
import { groupSize, type RequestGroup } from '@/panels/requests/groups'
import { ChangeCard } from '@/panels/tasks/ChangeRequests'
import { PermissionCard } from '@/panels/tasks/PermissionRequests'
import { StatusLight } from '@/panels/tasks/StatusPill'
import { reasonLine } from '@/panels/tasks/status-label'

/** Who the requests come from: the agent with its colour, blob and reason line, which opens it. */
function GroupHeader({ group, task }: { group: RequestGroup; task: TaskListEntry | undefined }) {
  const status = task === undefined ? null : listedStatus(task)
  const reason = task === undefined || status === null ? null : reasonLine(task, status)
  const { taskId } = group
  const body = (
    <>
      {task !== undefined && status !== null ? (
        <StatusLight status={status} place="home" agent={{ id: task.id, color: task.color }} />
      ) : (
        <Lightbulb aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-semibold">{group.title}</span>
        {reason !== null && <span className="truncate text-xs text-muted-foreground">{reason}</span>}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{groupSize(group)}</span>
    </>
  )
  const frame =
    'agent-stripe flex w-full min-w-0 items-center gap-2 border-b border-border py-1.5 pr-3 pl-3.5 text-left'
  if (taskId === null) {
    return <div className={frame}>{body}</div>
  }
  return (
    <button
      type="button"
      {...agentColorAttr(task?.color ?? null)}
      className={`${frame} outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11`}
      aria-label={`Open ${group.title}`}
      onClick={() => {
        navigate('agents', taskId)
      }}
    >
      {body}
    </button>
  )
}

interface RequestGroupCardProps {
  group: RequestGroup
  task: TaskListEntry | undefined
  answers: Answers
  /** Leaves the agent out of the header, as the drawer beside one agent does. */
  bare?: boolean
  /** Hides a request answered here until the next poll drops it. */
  onAnswered: (id: string) => void
}

/** One agent's pending requests, each answered in place, from tool calls and plans to notes. */
export function RequestGroupCard({ group, task, answers, bare = false, onAnswered }: RequestGroupCardProps) {
  return (
    <section
      aria-label={`Requests from ${group.title}`}
      data-task-id={group.taskId ?? undefined}
      className="border border-border"
    >
      {!bare && <GroupHeader group={group} task={task} />}
      <div className="space-y-2 p-2">
        {[...group.plans, ...group.tools].map((request) => (
          <PermissionCard
            key={request.id}
            request={request}
            onAnswered={() => {
              onAnswered(request.id)
            }}
          />
        ))}
        {group.access.map((request) => (
          <ChangeCard
            key={request.id}
            request={request}
            onAnswered={() => {
              onAnswered(request.id)
            }}
          />
        ))}
        {group.questions.length > 0 && (
          <AgentQuestions title={group.title} questions={group.questions} answers={answers} />
        )}
        {group.notes.map((note) => (
          <KnowledgeCard
            key={note.id}
            note={note}
            onChanged={() => {
              onAnswered(note.id)
            }}
          />
        ))}
      </div>
    </section>
  )
}
