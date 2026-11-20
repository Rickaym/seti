import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { PendingRewind } from '../store/rewinds.js'

/** Error texts of a truncated resume that Claude Code will refuse again, so it is never retried. */
const REFUSALS = ['Resume rejected by --resume-drops-turn:', 'No message found with message.uuid of:']

/** The resume options for a pending rewind; a rewind to the first prompt starts a new session. */
function rewoundOptions(options: Options, pending: PendingRewind): Options {
  const { resume, ...rest } = options
  if (pending.resume_at === null || resume === undefined) {
    return rest
  }
  const drops = pending.drops_turn === null ? {} : { resumeDropsTurn: pending.drops_turn }
  return { ...rest, resume, resumeSessionAt: pending.resume_at, ...drops }
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

/** Follows a session opened at a rewind point until Claude Code accepts or refuses it. */
async function* rewoundSession(
  session: AsyncIterable<SDKMessage>,
  applies: () => Promise<void>,
): AsyncGenerator<SDKMessage, string | null> {
  let applied = false
  try {
    for await (const m of session) {
      const refused = applied ? null : refusalOf(m)
      if (refused !== null) {
        return refused
      }
      if (!applied && m.type === 'system' && m.subtype === 'init') {
        await applies()
        applied = true
      }
      yield m
    }
  } catch (e) {
    const refused = !applied && e instanceof Error ? refusalOf(e) : null
    if (refused === null) {
      throw e
    }
    return refused
  }
  return null
}

/**
 * Runs a task's session like `query`, from the pending rewind point; a refused rewind resumes
 * plainly. `open` starts one query with the given options each time it is called, and `settle`
 * records whether Claude Code applied the rewind or refused it, with the reason.
 */
export async function* resumeSession(
  pending: PendingRewind | null,
  options: Options,
  open: (options: Options) => Query,
  settle: (rewindId: number, refused: string | null) => Promise<void>,
): AsyncGenerator<SDKMessage, void> {
  if (pending === null) {
    yield* open(options)
    return
  }
  const rewound = open(rewoundOptions(options, pending))
  const refused = yield* rewoundSession(rewound, async () => settle(pending.id, null))
  if (refused === null) {
    return
  }
  rewound.close()
  await settle(pending.id, refused)
  if (options.abortController?.signal.aborted !== true) {
    yield* open(options)
  }
}
