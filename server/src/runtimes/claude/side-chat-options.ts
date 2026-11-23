import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { Task } from '@seti/shared'
import { taskLauncher } from '../../launcher.js'
import { permissionSettings, systemAppend, workingDirs } from '../../session-options.js'
import { claudeLaunch } from './realise.js'

/** Tools that only read, which a side chat the user or the EA starts may use. */
export const READ_TOOLS = ['Read', 'Glob', 'Grep']

/** Model turns one answer may take: its reads, then the answer itself. */
const READING_TURNS = 8

/** Where a side chat forks the agent's conversation: its session, up to `at` when a rewind waits. */
export interface ForkPoint {
  session_id: string
  /** Last chain entry the agent's next turn keeps, when a rewind is pending. */
  at: string | null
}

function sideNote(reads: boolean): string {
  const tools = reads
    ? 'You may check files with Read, Glob and Grep; you cannot change anything or run commands.'
    : 'You have no tools here, so answer from what the conversation already holds.'
  return [
    'The user is asking a side question about this session. The question and your answer stay out of',
    'the session: the agent never sees them, and its work may still be in progress, so a tool call',
    `without a result is still running. ${tools} Answer briefly and directly.`,
  ].join(' ')
}

/**
 * Options for a side chat: a fork of the agent's session that Claude Code never writes to disk,
 * with read-only tools at most, no MCP servers, plugins or hooks, and the agent's model, sandbox,
 * egress proxy, permission rules and working folders.
 */
export async function sideChatOptions(
  task: Task,
  fork: ForkPoint,
  { reads, abortController }: { reads: boolean; abortController: AbortController },
): Promise<Options> {
  const dirs = workingDirs(task)
  const tools = reads ? READ_TOOLS : []
  const append = [await systemAppend(task.id), sideNote(reads)].filter((text) => text !== '')
  return {
    cwd: task.cwd,
    ...(task.model === null ? {} : { model: task.model }),
    ...(dirs.length === 0 ? {} : { additionalDirectories: dirs }),
    resume: fork.session_id,
    ...(fork.at === null ? {} : { resumeSessionAt: fork.at }),
    forkSession: true,
    persistSession: false,
    tools,
    allowedTools: tools,
    permissionMode: 'dontAsk',
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: ['user', 'project', 'local'],
    settings: { permissions: await permissionSettings(task), disableAllHooks: true },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: append.join('\n\n') },
    includePartialMessages: true,
    maxTurns: reads ? READING_TURNS : 1,
    abortController,
    ...claudeLaunch(await taskLauncher(task, 'side_chat', true)),
  }
}
