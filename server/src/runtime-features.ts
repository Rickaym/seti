import { RUNTIME_NAMES, type Task } from '@seti/shared'
import { HttpError } from './http.js'
import { agentCapabilities } from './runtimes/capabilities.js'

/**
 * Refuses a Claude Code feature for an agent on another runtime, saying so plainly: a Codex or
 * Gemini agent has no side chat, rewind or Bypass.
 */
export function refuseOffClaude(task: Pick<Task, 'runtime'>, feature: string): void {
  if (task.runtime !== 'claude') {
    throw new HttpError(409, `${RUNTIME_NAMES[task.runtime]} agents have no ${feature}`)
  }
}

/** Refuses a feature the agent's runtime does not declare, naming the runtime. */
export function refuseUndeclared(task: Pick<Task, 'runtime'>, declared: boolean, feature: string): void {
  if (!declared) {
    throw new HttpError(409, `${agentCapabilities(task.runtime).label} agents have no ${feature}`)
  }
}
