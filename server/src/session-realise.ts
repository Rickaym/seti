import type { Task } from '@seti/shared'
import type { LaunchPlan } from './launch-plan.js'
import { launcherFrom } from './launcher.js'
import { sessionHost } from './runtime-host.js'
import { adapterFor } from './runtimes/registry.js'
import type { SessionSpec } from './session-spec.js'

/** The options a process of the task starts with from the spec and launch plan it is handed. */
export async function realise(spec: SessionSpec, task: Task, plan: LaunchPlan, abortController: AbortController) {
  const launcher = await launcherFrom(task, 'agent', true, plan)
  const host = await sessionHost(task, launcher.sandboxed, abortController.signal)
  return adapterFor(spec.runtime).realise(spec, launcher, host, abortController)
}
