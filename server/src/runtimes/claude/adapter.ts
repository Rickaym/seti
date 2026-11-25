import { query, type Options, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { MCP_TRANSPORTS, projectClaude } from '@seti/shared'
import type { RuntimeAdapter, SessionInput } from '../adapter.js'
import { reportedCost } from './cost.js'
import { claudeLoadedMemory, claudeMemory, dreamOptions } from './dream.js'
import { claudePrompt } from './input.js'
import { realise } from './realise.js'
import { rewoundOptions } from './resume.js'
import { claudeSession, type ClaudeShapes } from './session.js'

/** Starts Claude Code through the SDK; a development server may load a fake instead. */
let transport: typeof query = query

/** Claude Code through the Claude Agent SDK, one process per session. */
export const claudeAdapter: RuntimeAdapter<ClaudeShapes, 'claude'> = {
  id: 'claude',
  capabilities: {
    gate: { rewriteInput: true, classifier: true },
    session: { fork: 'ephemeral' },
    rewind: { conversation: true, code: true },
    tools: { userServers: MCP_TRANSPORTS, plugins: true },
    sandbox: { optional: true },
    compaction: true,
    subagents: true,
    dream: {
      memory: claudeMemory,
      loaded: claudeLoadedMemory,
      open: async (spec, launcher, host, abortController) => {
        const options = dreamOptions(spec, launcher, host, abortController)
        return Promise.resolve(claudeSession(transport({ prompt: claudePrompt(once(spec.prompt)), options }), false))
      },
      reportedCost,
    },
  },
  // Claude Code wrote it, live or as Seti stored it.
  project: (raw) => projectClaude(raw as SDKMessage),
  realise,
  open: async (options, input, rewind) => {
    const started = rewind === null ? options : rewoundOptions(options, rewind)
    return Promise.resolve(claudeSession(transport({ prompt: claudePrompt(input), options: started }), rewind !== null))
  },
}

/** One input of text, after which the session ends. */
async function* once(text: string): AsyncIterable<SessionInput> {
  yield await Promise.resolve({ id: 'dream', content: { text, images: [] } })
}

/** Runs one Claude Code query outside a session, as a side chat does, and streams its messages. */
export const queryClaude = (options: Options, input: AsyncIterable<SessionInput>): Query =>
  transport({ prompt: claudePrompt(input), options })

/** Replaces the SDK's query with the one a module exports, such as the e2e suite's fake. */
export async function loadSdkModule(file: string): Promise<void> {
  const loaded = (await import(file)) as { query?: unknown }
  if (typeof loaded.query !== 'function') {
    throw new Error(`${file} exports no query function`)
  }
  transport = loaded.query as typeof query
}
