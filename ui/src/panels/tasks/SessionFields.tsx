import { warmCacheNote, type Task } from '@seti/shared'
import { Fields, Row } from '@/panels/tasks/SettingsFields'
import { PlannerFallback, WarmCaches } from '@/panels/tasks/StartFacts'
import { TaskCompact } from '@/panels/tasks/TaskCompact'
import { TaskCost } from '@/panels/tasks/TaskCost'
import { TaskCpu } from '@/panels/tasks/TaskCpu'
import { TaskMemory } from '@/panels/tasks/TaskMemory'
import { TaskModel } from '@/panels/tasks/TaskModel'

/** The Session tab of the agent settings: model, cost, caps, compaction and how it started. */
export function SessionFields({ task, running }: { task: Task; running: boolean }) {
  return (
    <Fields>
      {task.model !== null && (
        <Row label="Model">
          <TaskModel task={task} running={running} />
        </Row>
      )}
      <Row label="Cost">
        <TaskCost cost={task.cost_usd} />
      </Row>
      <Row label="Memory">
        <TaskMemory taskId={task.id} />
      </Row>
      <Row label="CPU">
        <TaskCpu taskId={task.id} />
      </Row>
      <Row label="Compaction">
        <TaskCompact taskId={task.id} />
      </Row>
      {task.setup?.planner === 'fallback' && (
        <Row label="Planner">
          <PlannerFallback setup={task.setup} />
        </Row>
      )}
      {warmCacheNote(task.warm_caches) !== null && (
        <Row label="Warm caches">
          <WarmCaches seeds={task.warm_caches} />
        </Row>
      )}
      {task.source_session_id !== null && (
        <Row label="Imported from">
          <span className="font-mono">{task.source_session_id}</span>
        </Row>
      )}
    </Fields>
  )
}
