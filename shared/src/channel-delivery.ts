import { z } from 'zod'
import type { InputMode } from './inputs.js'

/**
 * When a channel's update reaches a subscribed agent: at once, joining a running turn at its next
 * step; once the running turn is over; or only with the user's next message.
 */
export const DELIVERY_TIMINGS = ['now', 'after_turn', 'with_message'] as const
export type DeliveryTiming = (typeof DELIVERY_TIMINGS)[number]

/** What the agent's own update mode does with a channel update; null drops it. */
export const MODE_DELIVERY: Record<InputMode, DeliveryTiming | null> = {
  wake: 'after_turn',
  queue: 'with_message',
  off: null,
}

/**
 * The delivery an update gets, or null when the agent drops it. The agent's mode is a ceiling:
 * off drops every update, queue holds every one for the user's next message, and only wake lets a
 * subscription's own choice apply; a null choice follows the agent.
 */
export function effectiveDelivery(mode: InputMode, choice: DeliveryTiming | null): DeliveryTiming | null {
  return mode === 'wake' ? (choice ?? MODE_DELIVERY.wake) : MODE_DELIVERY[mode]
}

/** The agent as an update finds it; blocked is a turn that waits on the user's answer. */
export type AgentState = 'idle' | 'running' | 'blocked'

/**
 * What Seti does with an update: drop it, hold it for the user's next message, start a turn, join
 * the running turn at its next step, wait for the turn to end, or wait for the user's answer.
 */
export type DeliveryStep = 'drop' | 'hold' | 'start' | 'join' | 'after_turn' | 'after_answer'

const WAKING_STEPS: Record<Exclude<DeliveryTiming, 'with_message'>, Record<AgentState, DeliveryStep>> = {
  now: { idle: 'start', running: 'join', blocked: 'after_answer' },
  after_turn: { idle: 'start', running: 'after_turn', blocked: 'after_turn' },
}

/** What becomes of an update with this choice, for an agent in this mode and state. */
export function deliveryStep(mode: InputMode, choice: DeliveryTiming | null, state: AgentState): DeliveryStep {
  const delivery = effectiveDelivery(mode, choice)
  if (delivery === null) {
    return 'drop'
  }
  return delivery === 'with_message' ? 'hold' : WAKING_STEPS[delivery][state]
}

/** Sets when a subscribed agent gets the channel's updates; null follows the agent's update mode. */
export const subscriptionDeliveryInput = z.object({ delivery: z.enum(DELIVERY_TIMINGS).nullable() })
export type SubscriptionDeliveryInput = z.input<typeof subscriptionDeliveryInput>
