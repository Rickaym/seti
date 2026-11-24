import type { Task } from '@seti/shared'
import { HttpError } from './http.js'
import { agentCapabilities } from './runtimes/capabilities.js'

/**
 * Refuses a Claude Code feature for an agent whose runtime has none, saying so plainly: a Codex
 * agent has no side chat, rewind or Bypass.
 */
export function refuseOnCodex(task: Pick<Task, 'runtime'>, feature: string): void {
  if (task.runtime === 'codex') {
    throw new HttpError(409, `Codex agents have no ${feature}`)
  }
}

/** Refuses a feature the agent's runtime does not declare, naming the runtime. */
export function refuseUndeclared(task: Pick<Task, 'runtime'>, declared: boolean, feature: string): void {
  if (!declared) {
    throw new HttpError(409, `${agentCapabilities(task.runtime).label} agents have no ${feature}`)
  }
}
