import type { RuntimeEvent } from '../events.js'
import { projectAcp } from './acp/project.js'
import type { ClaudeMessage } from './claude/message.js'
import { projectClaude } from './claude/project.js'
import { projectCodex } from './codex/project.js'

/** The runtimes whose messages Seti stores, as a transcript row's `runtime` names them. */
export const STORED_RUNTIMES = ['claude', 'codex', 'gemini'] as const

export type StoredRuntime = (typeof STORED_RUNTIMES)[number]

/** The runtime a stored row names; a row stored before rows named one is Claude Code's. */
export const storedRuntime = (runtime: string | null | undefined): StoredRuntime =>
  STORED_RUNTIMES.find((each) => each === runtime) ?? 'claude'

/** The neutral events of one message as `runtime` wrote it and Seti stored it. */
export function projectRuntime(runtime: StoredRuntime, raw: unknown): RuntimeEvent[] {
  switch (runtime) {
    case 'codex':
      return projectCodex(raw)
    case 'gemini':
      return projectAcp(raw)
    case 'claude':
      return projectClaude(raw as ClaudeMessage)
  }
}
