import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { RewindRequest } from '../adapter.js'

/** Error texts of a truncated resume that Claude Code will refuse again, so it is never retried. */
const REFUSALS = ['Resume rejected by --resume-drops-turn:', 'No message found with message.uuid of:']

/** The resume options for a rewind; a rewind to the first prompt starts a new session. */
export function rewoundOptions(options: Options, rewind: RewindRequest): Options {
  const { resume, ...rest } = options
  if (rewind.keep === null || resume === undefined) {
    return rest
  }
  const drops = rewind.dropsTurn === null ? {} : { resumeDropsTurn: rewind.dropsTurn }
  return { ...rest, resume, resumeSessionAt: rewind.keep, ...drops }
}

const resultErrors = (m: SDKMessage) => (m.type === 'result' && m.subtype !== 'success' ? m.errors : [])

/** The refusal text when a message says Claude Code declined the truncated resume, else null. */
export function refusalOf(m: SDKMessage | Error): string | null {
  const texts = m instanceof Error ? [m.message] : resultErrors(m)
  for (const text of texts) {
    const at = Math.max(...REFUSALS.map((prefix) => text.indexOf(prefix)))
    if (at >= 0) {
      return text.slice(at)
    }
  }
  return null
}
