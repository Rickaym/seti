import { listedStatus, type ArchivedTaskEntry, type HomeAgentStats, type TaskListEntry } from '@seti/shared'
import { GitMerge, Trophy } from 'lucide-react'
import { agentColorAttr } from '@/lib/agent-color-sheet'
import { cn } from '@/lib/utils'
import { ArchivedLight, StatusLight } from '@/panels/tasks/StatusPill'

const SHOWN = 12

interface Row {
  task: TaskListEntry | ArchivedTaskEntry
  stats: HomeAgentStats
}

/** Agents by PRs merged over 30 days, then by turns; each row opens its agent. */
export function AgentBoard({
  stats,
  tasks,
  onOpen,
  onHighlight,
}: {
  stats: readonly HomeAgentStats[]
  tasks: ReadonlyMap<string, TaskListEntry | ArchivedTaskEntry>
  onOpen: (taskId: string) => void
  onHighlight: (taskId: string | null) => void
}) {
  const rows = stats.flatMap((entry): Row[] => {
    const task = tasks.get(entry.task_id)
    return task === undefined ? [] : [{ task, stats: entry }]
  })
  return (
    <section aria-labelledby="home-agents" className="flex flex-col gap-2">
      <h2 id="home-agents" className="flex items-center gap-1.5 text-sm font-semibold">
        <Trophy className="size-4" aria-hidden />
        Agents
      </h2>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No agent ran a turn or merged a PR in the last 30 days.</p>
      ) : (
        <ol className="flex flex-col">
          {rows.slice(0, SHOWN).map(({ task, stats: entry }, index) => (
            <li key={task.id}>
              <button
                type="button"
                {...agentColorAttr(task.color)}
                onClick={() => {
                  onOpen(task.id)
                }}
                onPointerEnter={() => {
                  onHighlight(`agent:${task.id}`)
                }}
                onPointerLeave={() => {
                  onHighlight(null)
                }}
                onFocus={() => {
                  onHighlight(`agent:${task.id}`)
                }}
                onBlur={() => {
                  onHighlight(null)
                }}
                className="flex w-full items-center gap-2 py-1.5 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11"
              >
                <span className="w-4 shrink-0 text-right text-muted-foreground tabular-nums">{index + 1}</span>
                <span
                  aria-hidden
                  className={cn(
                    'size-2.5 shrink-0',
                    task.color === null ? 'bg-muted-foreground' : 'bg-(--agent-stripe)',
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{task.title}</span>
                {'archive' in task ? <ArchivedLight /> : <StatusLight status={listedStatus(task)} place="home" />}
                <span
                  className="flex w-10 shrink-0 items-center justify-end gap-1 tabular-nums"
                  title="PRs merged in 30 days"
                >
                  <GitMerge className="size-3 text-muted-foreground" aria-label="merged" />
                  {entry.merged_30d}
                </span>
                <span
                  className="shrink-0 text-right whitespace-nowrap text-muted-foreground tabular-nums"
                  title="Turns in 30 days"
                >
                  {entry.turns_30d} {entry.turns_30d === 1 ? 'turn' : 'turns'}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {rows.length > SHOWN && <p className="text-xs text-muted-foreground">and {rows.length - SHOWN} more</p>}
    </section>
  )
}
