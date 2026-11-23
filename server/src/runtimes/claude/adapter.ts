import { query } from '@anthropic-ai/claude-agent-sdk'
import type { RuntimeAdapter } from '../adapter.js'
import { realise } from './realise.js'
import { claudeSession, type ClaudeShapes } from './session.js'

/** Starts Claude Code through the SDK; a development server may load a fake instead. */
let transport: typeof query = query

/** Claude Code through the Claude Agent SDK, one process per session. */
export const claudeAdapter: RuntimeAdapter<ClaudeShapes> = {
  id: 'claude',
  capabilities: {
    gate: { rewriteInput: true, classifier: true },
    session: { fork: 'ephemeral' },
    rewind: { conversation: true, code: true },
  },
  realise,
  open: async (start) => Promise.resolve(claudeSession(transport(start))),
}

/** Replaces the SDK's query with the one a module exports, such as the e2e suite's fake. */
export async function loadSdkModule(file: string): Promise<void> {
  const loaded = (await import(file)) as { query?: unknown }
  if (typeof loaded.query !== 'function') {
    throw new Error(`${file} exports no query function`)
  }
  transport = loaded.query as typeof query
}
