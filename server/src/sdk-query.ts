import { query } from '@anthropic-ai/claude-agent-sdk'

/** Starts a task's Claude Code process; a development server may load a fake instead. */
let current: typeof query = query

export const startQuery: typeof query = (args) => current(args)

/** Replaces the SDK's query with the one a module exports, such as the e2e suite's fake. */
export async function loadSdkModule(file: string): Promise<void> {
  const loaded = (await import(file)) as { query?: unknown }
  if (typeof loaded.query !== 'function') {
    throw new Error(`${file} exports no query function`)
  }
  current = loaded.query as typeof query
}
