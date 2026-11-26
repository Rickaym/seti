import { redactSecrets } from './scrub.js'
import { slackSendSummary } from './slack/destination.js'

/** What the runtime says of why it asks: its reason, and a path outside the agent's folders. */
interface AskOptions {
  decisionReason?: string
  blockedPath?: string
}

const SUMMARY_CHARS = 300

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 3)}...` : text)

const firstText = (input: Record<string, unknown>, keys: readonly string[]) =>
  keys.map((key) => input[key]).find((value): value is string => typeof value === 'string' && value.trim() !== '')

const SUMMARY_KEYS = ['command', 'file_path', 'notebook_path', 'url', 'query', 'path', 'pattern', 'description']
const MESSAGE_KEYS = ['text', 'message', 'body', 'content', 'subject']

/**
 * One line of what the call does, such as its command, file or URL, else its first text field. A
 * Slack send names where it goes, by name when Seti knows it, else saying the name is not known.
 */
export async function summarize(tool: string, input: Record<string, unknown>): Promise<string> {
  if (tool === 'ExitPlanMode') {
    return 'Approve the plan and start on it'
  }
  const text = firstText(input, [...SUMMARY_KEYS, ...MESSAGE_KEYS, ...Object.keys(input)]) ?? ''
  const shown = (await slackSendSummary(tool, input)) ?? text
  return clip(redactSecrets(shown.replace(/\s+/g, ' ').trim()), SUMMARY_CHARS)
}

const DESCRIPTION_CHARS = 200

/**
 * What the agent says a shell call is for, as one line of plain text: a Bash call's description,
 * or the one its runtime gave; null when it says nothing.
 */
export function describe(ask: { tool: string; input: Record<string, unknown>; description?: string }): string | null {
  const given = ask.tool === 'Bash' ? ask.input.description : undefined
  const text = ask.description ?? (typeof given === 'string' ? given : '')
  const line = redactSecrets(
    text
      .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
  return line === '' ? null : clip(line, DESCRIPTION_CHARS)
}

/**
 * Why Claude Code asked, in its own words, never the agent's: its description of the call, which
 * Claude Code also hands on, is left out.
 */
export function reasonOf(options: AskOptions, input: Record<string, unknown>): string | null {
  const given = options.decisionReason?.trim() ?? ''
  const reason = given === '' || given === input.description ? null : given
  const blocked = options.blockedPath === undefined ? '' : `Path: ${options.blockedPath}`
  const text = [reason ?? '', blocked].filter((part) => part !== '').join('. ')
  return text === '' ? null : redactSecrets(text)
}
