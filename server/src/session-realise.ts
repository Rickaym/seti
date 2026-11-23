import type { Task } from '@seti/shared'
import type { LaunchPlan } from './launch-plan.js'
import { launcherFrom } from './launcher.js'
import { sessionHost } from './runtime-host.js'
import { adapterFor } from './runtimes/registry.js'
import { TASK_ID_ENV } from './session-options.js'
import type { SessionSpec } from './session-spec.js'

/**
 * The options a process of the task starts with from the spec and launch plan it is handed. The
 * launcher names the task in the environment, so the resource views find the process whatever its
 * runtime.
 */
export async function realise(spec: SessionSpec, task: Task, plan: LaunchPlan, abortController: AbortController) {
  const started = await launcherFrom(task, 'agent', true, plan)
  const launcher = { ...started, env: { ...started.env, [TASK_ID_ENV]: task.id } }
  const host = await sessionHost(task, launcher.sandboxed, abortController.signal)
  return adapterFor(spec.runtime).realise(spec, launcher, host, abortController)
}
