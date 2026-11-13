import type { Task } from '@seti/shared'
import { FallbackMark, SwitchBackButton } from '@/panels/tasks/FallbackMark'

/** The model the session runs on, and while it is a fallback, the way back. */
export function TaskModel({
  task,
  running,
}: {
  task: Pick<Task, 'id' | 'model' | 'model_fallback'>
  running: boolean
}) {
  const fallback = task.model_fallback
  return (
    <span className="flex flex-wrap items-center gap-2" data-testid="task-model">
      <span className="font-mono break-all">{fallback?.fallback_model ?? task.model}</span>
      <FallbackMark fallback={fallback} />
      {fallback !== null && <SwitchBackButton taskId={task.id} fallback={fallback} running={running} />}
    </span>
  )
}
