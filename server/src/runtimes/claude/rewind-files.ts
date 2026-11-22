import {
  getSessionMessages,
  query,
  type RewindFilesResult,
  type SDKUserMessage,
  type SessionMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { Launcher } from '../../launcher.js'
import { claudeLaunch } from './realise.js'

const FILES_TIMEOUT_MS = 60_000

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
): Promise<RewindFilesResult> {
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
