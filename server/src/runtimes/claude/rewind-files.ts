import { getSessionMessages, query, type SDKUserMessage, type SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Launcher } from '../../launcher.js'
import { claudeLaunch } from './realise.js'

const FILES_TIMEOUT_MS = 60_000

/** What putting files back at a prompt did or would do; `error` says why it cannot. */
export interface FilesRewind {
  canRewind: boolean
  error?: string
  filesChanged?: string[]
  insertions?: number
  deletions?: number
}

/** A prompt to find in the chain: the last entry kept before it, and the text it was sent with. */
interface ChainPoint {
  keep: string | null
  text: string
}

const blockText = (block: unknown): string =>
  typeof block === 'object' && block !== null && 'text' in block && typeof block.text === 'string' ? block.text : ''

function isToolResult(block: unknown): boolean {
  return typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result'
}

/** The typed text of a user chain entry, or null for tool results and other entries. */
function promptEntryText(entry: SessionMessage): string | null {
  const { message } = entry
  if (entry.type !== 'user' || typeof message !== 'object' || message === null || !('content' in message)) {
    return null
  }
  const { content } = message
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content) || content.length === 0 || content.some(isToolResult)) {
    return null
  }
  return content.map(blockText).join('\n')
}

/** Where a rewind point sits in the session file Claude Code keeps. */
export interface ChainMatch {
  /** False when the session history is readable and the kept entry is not in it. */
  keep_found: boolean
  /** Uuid of the chosen prompt's own entry, which file checkpoints are keyed by. */
  prompt_uuid: string | null
  /** The same uuid when the rewind drops exactly that one turn, for Claude Code to check. */
  drops_turn: string | null
}

/** Finds the chosen prompt in the session chain, right after the kept entry. */
export function matchChain(chain: readonly SessionMessage[], point: ChainPoint): ChainMatch {
  const start = point.keep === null ? 0 : chain.findIndex((entry) => entry.uuid === point.keep) + 1
  if (chain.length > 0 && point.keep !== null && start === 0) {
    return { keep_found: false, prompt_uuid: null, drops_turn: null }
  }
  const prompts = chain.slice(start).flatMap((entry) => {
    const text = promptEntryText(entry)
    return text === null ? [] : [{ uuid: entry.uuid, text }]
  })
  const wanted = point.text.trim()
  const own = prompts.find((entry) => entry.text.includes(wanted))
  const only = prompts.length === 1 && own !== undefined && point.keep !== null
  return { keep_found: true, prompt_uuid: own?.uuid ?? null, drops_turn: only ? own.uuid : null }
}

/** The saved conversation of a Claude Code session, oldest first; empty when it cannot be read. */
export async function sessionChain(sessionId: string | null): Promise<SessionMessage[]> {
  if (sessionId === null) {
    return []
  }
  return getSessionMessages(sessionId).catch(() => [])
}

async function* idle(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  await new Promise((resolve) => {
    signal.addEventListener('abort', resolve, { once: true })
  })
  yield* []
}

/** Resumes the session to list, and unless dryRun put back, the files as they were at a prompt. */
export async function rewindFiles(
  session: { cwd: string; id: string; launcher: Launcher },
  promptUuid: string,
  dryRun: boolean,
): Promise<FilesRewind> {
  const abortController = new AbortController()
  const launcher = claudeLaunch(session.launcher)
  const resumed = query({
    prompt: idle(abortController.signal),
    options: {
      cwd: session.cwd,
      resume: session.id,
      enableFileCheckpointing: true,
      settingSources: [],
      abortController,
      ...launcher,
    },
  })
  const timer = setTimeout(() => {
    abortController.abort()
  }, FILES_TIMEOUT_MS)
  try {
    const planned = await resumed.rewindFiles(promptUuid, { dryRun: true })
    if (dryRun || !planned.canRewind) {
      return planned
    }
    const done = await resumed.rewindFiles(promptUuid)
    return { ...done, filesChanged: done.filesChanged ?? planned.filesChanged ?? [] }
  } catch (e) {
    return { canRewind: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
    abortController.abort()
    resumed.close()
  }
}
