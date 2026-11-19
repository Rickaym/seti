import { WAKING_SOURCES, heldForMessage, sourceCounts, type InputMode, type TaskInput } from '@seti/shared'
import { clockTime } from '@/components/account/format'

/** What holds the waiting updates: your next message, the running turn, a burst pause, or nothing. */
export type WaitingKind = 'message' | 'turn' | 'paused' | 'soon'

/** When waiting updates reach the agent: a kind for the bar's icon and the sentence its tip shows. */
export function waitingReason(
  mode: InputMode,
  running: boolean,
  pausedUntil: string | null,
  inputs: readonly TaskInput[],
): { kind: WaitingKind; text: string } {
  const waking = inputs.filter((input) => WAKING_SOURCES.includes(input.source) && !heldForMessage(input))
  if (mode !== 'wake' || waking.length === 0) {
    return { kind: 'message', text: 'They go with your next message.' }
  }
  if (running) {
    const joins = waking.some((input) => input.source === 'channel' && input.delivery === 'now')
    const when = joins ? 'at the next step of this turn' : 'when this turn ends'
    return { kind: 'turn', text: `The agent gets them ${when}.` }
  }
  if (pausedUntil !== null) {
    return {
      kind: 'paused',
      text: `Seti paused after a burst of automatic turns and hands them over at ${clockTime(pausedUntil)}.`,
    }
  }
  return { kind: 'soon', text: 'The agent gets them in a few seconds.' }
}

/** The question to ask before dismissing several waiting updates, with how many of each source. */
export function dismissQuestion(inputs: readonly TaskInput[]): string {
  const counts = sourceCounts(inputs.map((input) => input.source))
  return `Dismiss ${String(inputs.length)} waiting updates (${counts})? The agent never gets them; they stay in the transcript, marked dismissed.`
}
