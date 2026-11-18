import type { PromptPayload } from '@seti/shared'
import type { NextMessage } from './next-message.js'

/** Something that happened outside the conversation, written for the agent, and how many items. */
export interface TurnPreface {
  text: string
  count: number
}

/** The turn a preface is read for. */
export interface PrefacedTurn {
  /** It also takes what waits for the user's next message: a written message, or a hand-over. */
  held: boolean
}

/**
 * Returns what the agent should learn before its next turn, or null; read once per turn.
 * @public
 */
export type TurnPrefaceProvider = (taskId: string, turn: PrefacedTurn) => Promise<TurnPreface | null>

const prefaceProviders: TurnPrefaceProvider[] = []

/** @public */
export function registerTurnPreface(provider: TurnPrefaceProvider): void {
  prefaceProviders.push(provider)
}

const USER_FOLLOWS = 'The message from the user follows.'
const AUTO_ACT = [
  'Act on them as this task requires, the way the user would expect.',
  'If nothing needs doing, say so in one or two sentences.',
]
const AUTO_TURN = ['No message from the user came with these updates.', ...AUTO_ACT].join(' ')
const AUTO_QUEUED = [
  'No message from the user came with these updates; they arrived during your previous turn.',
  ...AUTO_ACT,
].join(' ')
const AUTO_JOINED = [
  'No message from the user came with these updates; they arrived while you were working.',
  'Act on them as this task requires, then carry on with your work.',
  'If nothing needs doing, carry on without comment.',
].join(' ')

function autoText(next: NextMessage, queued: boolean): string {
  if (!queued) {
    return AUTO_TURN
  }
  return next.priority === undefined ? AUTO_QUEUED : AUTO_JOINED
}

type Prefaced = Pick<NextMessage, 'prompt' | 'held'>

async function prefaces(taskId: string, { prompt, held }: Prefaced): Promise<TurnPreface[]> {
  if (prompt?.startsWith('/') === true) {
    return []
  }
  const turn = { held: prompt !== null || held === true }
  const found = await Promise.all(prefaceProviders.map(async (provider) => provider(taskId, turn)))
  return found.filter((preface) => preface !== null)
}

const prefaceCount = (found: readonly TurnPreface[]) => found.reduce((sum, preface) => sum + preface.count, 0)

/** How many items the prefaces would hand the agent with this prompt now. */
export const pendingPrefaces = async (taskId: string, message: Prefaced) =>
  prefaceCount(await prefaces(taskId, message))

/** Tells the agent a message came from the EA or another agent, never the user. */
const fromNote = (from: string) => `This message comes from ${from}, not the user.`

function composePrompt(found: readonly TurnPreface[], next: NextMessage, queued: boolean): string {
  const { prompt } = next
  const texts = found.map((preface) => preface.text)
  if (prompt === null) {
    return [...texts, autoText(next, queued)].join('\n\n')
  }
  return texts.length === 0 ? prompt : [...texts, USER_FOLLOWS, prompt].join('\n\n')
}

/** The prompt row of a message, and the text the agent gets for it with the prefaces first. */
export async function promptFor(
  taskId: string,
  next: NextMessage,
  queued: boolean,
): Promise<{ payload: PromptPayload; text: string }> {
  const { prompt, interrupted, retry, attachments = [], client_id: clientId, from } = next
  const found = await prefaces(taskId, next)
  const count = prefaceCount(found)
  const payload: PromptPayload = {
    text: prompt ?? '',
    ...(prompt === null ? { auto: true } : {}),
    ...(prompt === null && next.held === true ? { held: true } : {}),
    ...(count > 0 ? { inputs: count } : {}),
    ...(interrupted ? { interrupted } : {}),
    ...(queued ? { queued: 'waiting' } : {}),
    ...(retry === true ? { retry } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(clientId === undefined ? {} : { client_id: clientId }),
    ...(from === undefined ? {} : { from }),
  }
  const told = from === undefined || prompt === null ? next : { ...next, prompt: `${fromNote(from)}\n\n${prompt}` }
  return { payload, text: composePrompt(found, told, queued) }
}
