import type { SubtaskBrief, TaskListEntry } from '@seti/shared'
import { SubtaskView } from '@/panels/tasks/SubtaskView'
import { TaskDetail } from '@/panels/tasks/TaskDetail'

interface AgentViewProps {
  task: TaskListEntry
  /** The subagent the address names, shown in place of the agent. */
  subId: string | null
  onChanged: () => void
  onSubtasks: (taskId: string, subtasks: readonly SubtaskBrief[]) => void
}

/** One agent, or one of its subagents, as the agent page or a frame shows it. */
export function AgentView({ task, subId, onChanged, onSubtasks }: AgentViewProps) {
  if (subId !== null) {
    return <SubtaskView key={`${task.id}/${subId}`} task={task} toolUseId={subId} onSubtasks={onSubtasks} />
  }
  return <TaskDetail key={task.id} task={task} onChanged={onChanged} onSubtasks={onSubtasks} />
}
