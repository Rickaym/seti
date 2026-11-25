import { RUNTIME_NAMES, warmCacheNote, type AgentCapabilities, type Task } from '@seti/shared'
import { Hint } from '@/components/Hint'
import { useCapabilities } from '@/hooks/useCapabilities'
import { compactionGaps } from '@/lib/compaction-gaps'
import { NotOnRuntime } from '@/panels/tasks/NotOnCodex'
import { OpinionSpend } from '@/panels/tasks/OpinionSpend'
import { Fields, Row } from '@/panels/tasks/SettingsFields'
import { PlannerFallback, WarmCaches } from '@/panels/tasks/StartFacts'
import { TaskCompact } from '@/panels/tasks/TaskCompact'
import { TaskCost } from '@/panels/tasks/TaskCost'
import { TaskCpu } from '@/panels/tasks/TaskCpu'
import { TaskMemory } from '@/panels/tasks/TaskMemory'
import { TaskModel } from '@/panels/tasks/TaskModel'

/** The runtime and what the agent was started with, shown for Codex and for a picked Claude model. */
function runtimeLine(task: Task): string | null {
  const model = task.runtime === 'codex' ? null : task.requested_model
  const parts = [RUNTIME_NAMES[task.runtime], model, task.requested_effort]
  const picked = parts.filter((part) => part !== null)
  return task.runtime === 'codex' || picked.length > 1 ? picked.join(', ') : null
}

/** The Session tab of the agent settings: model, cost, caps, compaction and how it started. */
export function SessionFields({ task, running }: { task: Task; running: boolean }) {
  const caps = useCapabilities(task)
  return (
    <Fields>
      {task.model !== null && (
        <Row label="Model">
          <TaskModel task={task} running={running} />
        </Row>
      )}
      {runtimeLine(task) !== null && <Row label="Runtime">{runtimeLine(task)}</Row>}
      <Row label="Cost">
        <TaskCost cost={task.cost_usd} estimated={task.runtime === 'codex'} />
        <OpinionSpend taskId={task.id} />
      </Row>
      <Row label="Memory">
        <TaskMemory taskId={task.id} />
      </Row>
      <Row label="CPU">
        <TaskCpu taskId={task.id} />
      </Row>
      <Row label="Compaction">
        {caps === null || caps.compaction ? (
          <div className="space-y-1">
            <TaskCompact taskId={task.id} />
            <CompactionGaps caps={caps} />
          </div>
        ) : (
          <NotOnRuntime
            label={caps.label}
            reason={`${caps.label} compacts its context on its own; this rule does not apply.`}
          />
        )}
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

/** A quiet note, with the detail in its tooltip, when the runtime honours only part of the rule. */
function CompactionGaps({ caps }: { caps: AgentCapabilities | null }) {
  const gaps = caps === null ? null : compactionGaps(caps.label, caps.compaction_ignores)
  if (caps === null || gaps === null) {
    return null
  }
  return (
    <Hint text={gaps}>
      <span className="text-2xs text-muted-foreground">Partly on {caps.label}</span>
    </Hint>
  )
}
