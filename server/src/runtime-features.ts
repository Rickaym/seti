import type { Task } from '@seti/shared'
import { HttpError } from './http.js'

/**
 * Refuses a Claude Code feature for an agent whose runtime has none, saying so plainly: a Codex
 * agent has no side chat, rewind or Bypass.
 */
export function refuseOnCodex(task: Pick<Task, 'runtime'>, feature: string): void {
  if (task.runtime === 'codex') {
    throw new HttpError(409, `Codex agents have no ${feature}`)
  }
}
