import { z } from 'zod'

/** Slack send tools of an MCP server, such as slack_send_message; drafts and schedules count. */
const SEND_TOOL = /(?:^|_)(send_message|send_message_draft|schedule_message)$/
const VERBS: Record<string, string> = {
  send_message: 'Send',
  send_message_draft: 'Draft',
  schedule_message: 'Schedule',
}

const isChannel = (id: string) => /^[CG]/.test(id)
const isPerson = (id: string) => /^[UW]/.test(id)

/** How a channel or person reads, `#deploys` or `Dana`; null while Seti does not know the name. */
export function shownSlackName(id: string, names: ReadonlyMap<string, string>): string | null {
  const name = names.get(id)
  if (name === undefined) {
    return null
  }
  return isChannel(id) ? `#${name}` : name
}

/** A channel or person as people read it, with a plain note when Seti does not know the name. */
export function slackPlace(id: string, names: ReadonlyMap<string, string>): string {
  const shown = shownSlackName(id, names)
  if (shown !== null) {
    return shown
  }
  if (isChannel(id)) {
    return `channel ${id}, name not known`
  }
  return isPerson(id) ? `Slack user ${id}, name not known` : `direct message ${id}, name not known`
}

const fieldOf = (input: unknown, key: string): string | null => {
  const value = typeof input === 'object' && input !== null ? (input as Record<string, unknown>)[key] : undefined
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** The Slack channel, DM or person a send call addresses; null for any other call. */
export function slackSendTarget(tool: string, input: unknown): string | null {
  const name = tool.split('__').at(-1) ?? tool
  if (!/slack/i.test(tool) || !SEND_TOOL.test(name)) {
    return null
  }
  return fieldOf(input, 'channel_id') ?? fieldOf(input, 'channel')
}

/** Where a Slack send call goes, such as `Send to #deploys` or `DM to Dana`; null for other calls. */
export function slackDestination(tool: string, input: unknown, names: ReadonlyMap<string, string>): string | null {
  const target = slackSendTarget(tool, input)
  if (target === null) {
    return null
  }
  const name = tool.split('__').at(-1) ?? tool
  const verb = VERBS[SEND_TOOL.exec(name)?.[1] ?? ''] ?? 'Send'
  const thread = fieldOf(input, 'thread_ts') === null ? '' : ', in a thread'
  const dm = isPerson(target) || (target.startsWith('D') && names.has(target))
  const where = dm ? `DM to ${slackPlace(target, names)}` : `${verb} to ${slackPlace(target, names)}`
  return dm && verb !== 'Send' ? `${verb} a ${where}${thread}` : `${where}${thread}`
}

/** The read that makes the Slack MCP server state a channel's or person's name, which Seti learns. */
function lookUpCall(target: string): string {
  if (isChannel(target)) {
    return `slack_read_channel with channel_id ${target} and limit 1`
  }
  return isPerson(target)
    ? `slack_read_user_profile with user_id ${target}`
    : 'slack_list_user_channels with types im,mpim'
}

/**
 * What a denied Slack send tells the agent when the user asks it to look the destination up
 * first, so the request it makes next shows the name.
 */
export const slackLookUpNote = (target: string): string =>
  `The user wants to see where this goes before allowing it, and Seti does not know the name of ${target}. ` +
  `Look it up with ${lookUpCall(target)}, then make the same send again.`

/** Asks for the names Seti knows of some Slack ids, comma separated. */
export const slackNamesQuery = z.object({
  ids: z
    .string()
    .max(2000)
    .transform((ids) => ids.split(',').filter((id) => /^[A-Z][A-Z0-9]{8,}$/.test(id))),
})

/** The names Seti knows, by id; an unknown id is absent. */
export type SlackNames = Record<string, string>
