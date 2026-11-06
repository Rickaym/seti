import type { PromptPayload } from '@seti/shared'
import type { NextMessage } from './agent-session.js'

/** Something that happened outside the conversation, written for the agent, and how many items. */
export interface TurnPreface {
  text: string
  count: number
}

/**
 * Returns what the agent should learn before its next turn, or null; read once per turn.
 * @public
 */
export type TurnPrefaceProvider = (taskId: string) => Promise<TurnPreface | null>

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

async function prefaces(taskId: string, prompt: string): Promise<TurnPreface[]> {
  if (prompt.startsWith('/')) {
    return []
  }
  const found = await Promise.all(prefaceProviders.map(async (provider) => provider(taskId)))
  return found.filter((preface) => preface !== null)
}

const prefaceCount = (found: readonly TurnPreface[]) => found.reduce((sum, preface) => sum + preface.count, 0)

/** How many items the prefaces would hand the agent with this prompt now. */
export const pendingPrefaces = async (taskId: string, prompt: string | null) =>
  prefaceCount(await prefaces(taskId, prompt ?? ''))

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
  const found = await prefaces(taskId, prompt ?? '')
  const count = prefaceCount(found)
  const payload: PromptPayload = {
    text: prompt ?? '',
    ...(prompt === null ? { auto: true } : {}),
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
