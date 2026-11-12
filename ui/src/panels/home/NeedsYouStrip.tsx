import { listedStatus, waitsOnYou, type TaskListEntry } from '@seti/shared'
import { CircleAlert } from 'lucide-react'
import { useNeedsYou } from '@/hooks/useNeedsYou'
import { agentColorAttr } from '@/lib/agent-color-sheet'
import { useOpenFromNeedsYou } from '@/panels/questions/useQuestionsPane'
import { StatusLight } from '@/panels/tasks/StatusPill'
import { reasonLine } from '@/panels/tasks/status-label'

const SHOWN = 3

/** The agents that cannot go on without the user, first on the page; nothing when none wait. */
export function NeedsYouStrip({ tasks }: { tasks: readonly TaskListEntry[] }) {
  const { open } = useNeedsYou()
  const openAgent = useOpenFromNeedsYou()
  const waiting = tasks
    .map((task) => ({ task, status: listedStatus(task) }))
    .filter(({ task, status }) => waitsOnYou(task, status))
    .sort((a, b) => Date.parse(a.task.updated_at) - Date.parse(b.task.updated_at))
  if (waiting.length === 0) {
    return null
  }
  return (
    <section
      aria-label="Needs you"
      className="flex shrink-0 items-center gap-3 overflow-x-auto border-b border-border bg-card px-4 py-2 text-xs max-md:flex-col max-md:items-stretch max-md:gap-1 max-md:px-3"
    >
      <button
        type="button"
        onClick={open}
        className="flex shrink-0 items-center gap-1.5 font-semibold text-destructive outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        <CircleAlert className="size-3.5" aria-hidden />
        {waiting.length} need you
      </button>
      {waiting.slice(0, SHOWN).map(({ task, status }) => (
        <button
          key={task.id}
          type="button"
          {...agentColorAttr(task.color)}
          onClick={() => {
            openAgent(task.id)
          }}
          className="agent-stripe flex min-w-0 items-center gap-2 border border-border py-1 pr-2 pl-3 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring md:max-w-80"
        >
          <StatusLight status={status} place="home" />
          <span className="shrink-0 font-medium">{task.title}</span>
          <span className="truncate text-muted-foreground">{reasonLine(task, status)}</span>
        </button>
      ))}
      {waiting.length > SHOWN && (
        <button
          type="button"
          onClick={open}
          className="shrink-0 text-muted-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          and {waiting.length - SHOWN} more
        </button>
      )}
    </section>
  )
}
