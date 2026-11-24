import type { RuntimeEvent } from '../events.js'
import type { ClaudeMessage } from './claude/message.js'
import { projectClaude } from './claude/project.js'
import { projectCodex } from './codex/project.js'

/** The runtimes whose messages Seti stores, as a transcript row's `runtime` names them. */
export const STORED_RUNTIMES = ['claude', 'codex'] as const

export type StoredRuntime = (typeof STORED_RUNTIMES)[number]

/** The runtime a stored row names; a row stored before rows named one is Claude Code's. */
export const storedRuntime = (runtime: string | null | undefined): StoredRuntime =>
  runtime === 'codex' ? 'codex' : 'claude'

/** The neutral events of one message as `runtime` wrote it and Seti stored it. */
export const projectRuntime = (runtime: StoredRuntime, raw: unknown): RuntimeEvent[] =>
  runtime === 'codex' ? projectCodex(raw) : projectClaude(raw as ClaudeMessage)
