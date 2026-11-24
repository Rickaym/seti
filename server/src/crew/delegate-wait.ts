import type { AgentInput } from '@seti/shared'
import type { AgentWait } from '../store/agent-waits.js'

/** Waits a caller holds inside its own tool call, by wait id; each takes the turn's end once. */
const held = new Map<number, (input: AgentInput) => void>()

/** The call that holds this wait now, which takes the turn's end instead of an update; once. */
export function takeHeldWait(waitId: number): ((input: AgentInput) => void) | undefined {
  const hand = held.get(waitId)
  held.delete(waitId)
  return hand
}

/** A wait a call holds, set up before the agent's first turn starts so no turn end is missed. */
export interface HeldWait {
  hold: (wait: AgentWait) => void
  /** The turn's end, or null at the time limit or when the call is cancelled. */
  result: (minutes: number, signal: AbortSignal | undefined) => Promise<AgentInput | null>
}

/**
 * Holds one wait in the calling tool. Until it ends the turn's end comes back to the call; after
 * it ends, by time or by cancel, the wait stays an ordinary one and the end arrives as an update.
 */
export function heldWait(): HeldWait {
  let waitId: number | null = null
  let ended: AgentInput | null = null
  let settle: ((input: AgentInput | null) => void) | null = null
  const take = (input: AgentInput) => {
    ended = input
    settle?.(input)
  }
  return {
    hold: (wait) => {
      waitId = wait.id
      held.set(wait.id, take)
    },
    result: async (minutes, signal) =>
      new Promise((resolve) => {
        const finish = (input: AgentInput | null) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', cancel)
          if (waitId !== null) {
            held.delete(waitId)
          }
          resolve(input)
        }
        const cancel = () => {
          finish(null)
        }
        const timer = setTimeout(cancel, minutes * 60_000)
        settle = finish
        if (ended !== null || signal?.aborted === true) {
          finish(ended)
          return
        }
        signal?.addEventListener('abort', cancel, { once: true })
      }),
  }
}
