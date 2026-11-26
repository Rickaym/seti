import { idsIn, readableSlack, slackDestination, slackSendTarget } from '@seti/shared'
import { now } from '../db.js'
import { slackNames } from '../store/slack-names.js'

/** A name last seen longer ago than this says when, since the channel may have been renamed. */
export const NAME_STALE_MS = 30 * 24 * 3_600_000

export function messageOf(input: Record<string, unknown>): string {
  const text = input.message ?? input.text
  return typeof text === 'string' ? text : ''
}

/**
 * A Slack send as a request reads it, `Send to #deploys: text` with mentions by name, and
 * when the name was last seen if that is long ago; null for any other call. Names never come
 * from message text (CHN-33).
 */
export async function slackSendSummary(tool: string, input: Record<string, unknown>): Promise<string | null> {
  const target = slackSendTarget(tool, input)
  if (target === null) {
    return null
  }
  const known = await slackNames.seen(target)
  const where = slackDestination(tool, input, new Map(known === undefined ? [] : [[target, known.name]]))
  const old = known !== undefined && Date.parse(now()) - Date.parse(known.learned_at) > NAME_STALE_MS
  const seen = old ? ` (name seen ${known.learned_at.slice(0, 10)})` : ''
  const text = messageOf(input)
  const mentioned = await slackNames.of(idsIn(text))
  return `${where ?? target}${seen}: ${readableSlack(text, mentioned, false)}`
}
