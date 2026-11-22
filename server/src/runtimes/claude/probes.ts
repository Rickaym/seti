import os from 'node:os'
import {
  query,
  type Options,
  type Query,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'

type Env = Record<string, string | undefined>

/** Starts Claude Code in the user's home folder with nothing to do, to read its account. */
export const openAccountProbe = (prompt: AsyncIterable<SDKUserMessage>, env: Env): Query =>
  query({ prompt, options: { cwd: os.homedir(), settingSources: ['user', 'project', 'local'], env } })

/** What Seti decides about a folder probe's process: its settings, env, plugins and spawn. */
type FolderProbeOptions = Pick<Options, 'settingSources' | 'env' | 'plugins' | 'spawnClaudeCodeProcess'>

/** Starts Claude Code in a folder with nothing to do, to read what it offers there. */
export const openFolderProbe = (cwd: string, prompt: AsyncIterable<SDKUserMessage>, options: FolderProbeOptions) =>
  query({ prompt, options: { cwd, ...options } })

/** One prompt for a model, with no tools, settings or saved session. */
interface OneShot {
  model: string
  system: string
  prompt: string
  env: Env
}

/** Runs the prompt for a single turn; its result message, or null when none came. */
export async function askOnce(request: OneShot, signal: AbortSignal): Promise<SDKResultMessage | null> {
  const abortController = new AbortController()
  signal.addEventListener('abort', () => {
    abortController.abort()
  })
  const session = query({
    prompt: request.prompt,
    options: {
      model: request.model,
      systemPrompt: request.system,
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      maxTurns: 1,
      thinking: { type: 'disabled' },
      cwd: os.tmpdir(),
      env: request.env,
      abortController,
    },
  })
  try {
    for await (const message of session) {
      if (message.type === 'result') {
        return message
      }
    }
  } finally {
    session.close()
  }
  return null
}
