import { Registry, type Disposer, type ModManifest, type ModTaskEvent, type TaskEvent } from '@seti/shared'
import { onPrLinkChange, type PrLinkChange } from '../audit.js'
import { onTurnEnd } from '../runner.js'
import { onAnyTaskEvent } from '../task-events.js'
import { fireModEvent } from './logic/service.js'
import { filterCovers } from './scopes.js'

/** A running mod that hears agent events, within the agents its tasks.read grant covers. */
interface TaskEventListener {
  mod: string
  events: ReadonlySet<ModTaskEvent>
  /** The tasks.read filter; undefined for every agent. */
  agents: readonly string[] | undefined
}

const listeners = new Registry<TaskEventListener>('task event listener', (entry) => entry.mod)

/** Hears the task events the manifest declares while the mod runs. */
export function listenToTaskEvents(
  manifest: ModManifest,
  agents: readonly string[] | undefined,
  track: (dispose: Disposer) => Disposer,
): void {
  if (manifest.contributes.taskEvents.length > 0) {
    track(listeners.register({ mod: manifest.id, events: new Set(manifest.contributes.taskEvents), agents }))
  }
}

/** Fires one agent event for every mod that hears it and may read that agent. */
function fire(type: ModTaskEvent, taskId: string): void {
  const at = new Date().toISOString()
  for (const entry of listeners.list()) {
    if (entry.events.has(type)) {
      void filterCovers(entry.agents, taskId)
        .then(async (covered) =>
          covered ? fireModEvent(entry.mod, { kind: 'task', type, taskId, at }, { caller: 'task' }) : null,
        )
        .catch(() => undefined)
    }
  }
}

/** The mod task event a stream event is, if any. */
function typeOf(event: TaskEvent): ModTaskEvent | null {
  if (event.type === 'status') {
    return 'status_changed'
  }
  return event.type === 'blocked' && event.blocked !== null ? 'needs_you' : null
}

function prType(change: PrLinkChange): ModTaskEvent | null {
  if (change.linked) {
    return 'pr_linked'
  }
  return change.merged === true ? 'pr_merged' : null
}

let started = false

/** Turns agent events into mods' onTaskEvent events; later calls change nothing. */
export function startModTaskEvents(): void {
  if (started) {
    return
  }
  started = true
  onAnyTaskEvent((taskId, event) => {
    const type = typeOf(event)
    if (type !== null) {
      fire(type, taskId)
    }
  })
  onTurnEnd((taskId) => {
    fire('turn_finished', taskId)
  })
  onPrLinkChange((change) => {
    const type = prType(change)
    if (type !== null) {
      fire(type, change.taskId)
    }
  })
}
