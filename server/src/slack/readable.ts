import type { EventFields } from '../channels/types.js'
import { slackNames } from '../store/slack-names.js'
import { threadSource } from '../threads/sources.js'
import { idsIn, readableSlack } from './names.js'

/** A Slack event's title and text with the names Seti knows in place of ids and markup. */
export async function readableFields(preset: string, fields: EventFields): Promise<EventFields> {
  if (threadSource(preset) === undefined) {
    return fields
  }
  const names = await slackNames.of(idsIn(`${fields.title}\n${fields.detail}`))
  return { ...fields, title: readableSlack(fields.title, names), detail: readableSlack(fields.detail, names) }
}
