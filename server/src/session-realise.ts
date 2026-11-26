import type { Task } from '@seti/shared'
import { acpHost } from './acp-host.js'
import { codexHost } from './codex-host.js'
import type { LaunchPlan } from './launch-plan.js'
import { launcherFrom } from './launcher.js'
import { sessionHost } from './runtime-host.js'
import type { AcpShapes } from './runtimes/acp/session.js'
import type { RewindRequest, SessionInput } from './runtimes/adapter.js'
import type { ClaudeShapes } from './runtimes/claude/session.js'
import type { CodexShapes } from './runtimes/codex/session.js'
import { adapterFor, type DefaultSession } from './runtimes/registry.js'
import { TASK_ID_ENV } from './session-options.js'
import type { SessionSpec } from './session-spec.js'

/** What a process of either runtime starts from, by the runtime that starts it. */
export type Realised =
  | { runtime: 'claude'; options: ClaudeShapes['realised'] }
  | { runtime: 'codex'; options: CodexShapes['realised'] }
  | { runtime: 'gemini'; options: AcpShapes['realised'] }

/**
 * Where the task's process starts from its plan. The launcher names the task in the environment,
 * so the resource views find the process whatever its runtime.
 */
async function launcherFor(task: Task, plan: LaunchPlan) {
  const started = await launcherFrom(task, 'agent', true, plan)
  return { ...started, env: { ...started.env, [TASK_ID_ENV]: task.id } }
}

/** The options a Claude Code process of the task starts with from the spec and plan it is handed. */
export async function realiseClaude(
  spec: SessionSpec<'claude'>,
  task: Task,
  plan: LaunchPlan,
  abortController: AbortController,
) {
  const launcher = await launcherFor(task, plan)
  const host = await sessionHost(task, launcher.sandboxed, abortController.signal)
  return adapterFor('claude').realise(spec, launcher, host, abortController)
}

export const isCodexSpec = (spec: SessionSpec): spec is SessionSpec<'codex'> => spec.runtime === 'codex'
export const isGeminiSpec = (spec: SessionSpec): spec is SessionSpec<'gemini'> => spec.runtime === 'gemini'
export const isClaudeSpec = (spec: SessionSpec): spec is SessionSpec<'claude'> => spec.runtime === 'claude'

/** What a process of the task starts with from the spec and launch plan it is handed. */
export async function realise(
  spec: SessionSpec,
  task: Task,
  plan: LaunchPlan,
  abortController: AbortController,
): Promise<Realised> {
  if (isCodexSpec(spec)) {
    const launcher = await launcherFor(task, plan)
    const host = await codexHost(task, abortController.signal)
    return { runtime: 'codex', options: await adapterFor('codex').realise(spec, launcher, host, abortController) }
  }
  if (isGeminiSpec(spec)) {
    const launcher = await launcherFor(task, plan)
    const host = await acpHost(task, abortController.signal)
    return { runtime: 'gemini', options: await adapterFor('gemini').realise(spec, launcher, host, abortController) }
  }
  if (!isClaudeSpec(spec)) {
    throw new Error(`Seti has no runtime named ${spec.runtime}`)
  }
  return { runtime: 'claude', options: await realiseClaude(spec, task, plan, abortController) }
}

/** Opens the realised process; a Codex or Gemini session has only the controls all runtimes have. */
export async function openRealised(
  realised: Realised,
  input: AsyncIterable<SessionInput>,
  at: RewindRequest | null,
): Promise<DefaultSession> {
  if (realised.runtime === 'claude') {
    return adapterFor('claude').open(realised.options, input, at)
  }
  const session =
    realised.runtime === 'codex'
      ? await adapterFor('codex').open(realised.options, input, at)
      : await adapterFor('gemini').open(realised.options, input, at)
  const stop = session.stopBackground
  return {
    events: session.events,
    interrupt: async () => session.interrupt(),
    close: () => {
      session.close()
    },
    ...(stop === undefined ? {} : { stopBackground: stop }),
  }
}
