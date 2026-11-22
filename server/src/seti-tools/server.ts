import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { SetiControlLevel, Task } from '@seti/shared'
import { z } from 'zod'
import { asAgent } from '../access.js'
import { tasks } from '../db.js'
import { describeIssues } from '../http.js'
import { inProcessServer } from '../runtimes/claude/tool-server.js'
import { scrubValue } from '../scrub.js'
import { toolsFor } from './levels.js'
import { noteProcessControl } from './process-control.js'
import type { SetiTool } from './tool.js'

/** The name agents see the server by; its tools reach them as mcp__seti__<tool>. */
const SETI_SERVER = 'seti'

/** Long answers are cut here, below Claude Code's own limit, so the agent gets the cut note. */
const RESULT_MAX = 40_000

const errorText = (e: unknown) => {
  if (e instanceof z.ZodError) {
    return describeIssues(e)
  }
  return e instanceof Error ? e.message : String(e)
}

function textOf(result: unknown): string {
  const text = typeof result === 'string' ? result : JSON.stringify(scrubValue(result), null, 1)
  return text.length <= RESULT_MAX ? text : `${text.slice(0, RESULT_MAX)}\n[Cut at ${String(RESULT_MAX)} characters.]`
}

const REFUSALS: Record<SetiControlLevel, (name: string) => string> = {
  off: () => 'Seti control is off for this agent; the user sets it in its access.',
  self: (name) => `${name} reaches past you, and your Seti control is Self; the user can give you Full in your access.`,
  full: (name) => (name.startsWith('mod_') ? `The mod of ${name} is off now.` : `${name} is not a seti tool.`),
}

/**
 * Runs one tool as the calling agent, as the agent's Seti control level at the time of the call
 * has it: a tool beyond that level is refused, and at Self the agent it acts on is the caller.
 */
export async function callSetiTool(entry: SetiTool, taskId: string, args: unknown, signal?: AbortSignal) {
  try {
    const caller = await tasks.get(taskId)
    if (caller === undefined) {
      throw new Error('This agent no longer exists in Seti.')
    }
    const current = toolsFor(caller.seti_control).find((candidate) => candidate.name === entry.name)
    if (current === undefined) {
      throw new Error(REFUSALS[caller.seti_control](entry.name))
    }
    const ctx = signal === undefined ? { caller } : { caller, signal }
    const result = await asAgent(caller, async () => current.call(args, ctx))
    return { content: [{ type: 'text' as const, text: textOf(result) }] }
  } catch (e) {
    return { content: [{ type: 'text' as const, text: errorText(e) }], isError: true }
  }
}

/** The seti tools a session gets at the agent's Seti control level. */
export const sessionTools = (task: Pick<Task, 'seti_control'>): readonly SetiTool[] => toolsFor(task.seti_control)

/** The in-process seti MCP server of one agent's session; every call acts as that agent. */
function setiMcpServer(task: Task): McpServerConfig {
  return inProcessServer(
    SETI_SERVER,
    sessionTools(task).map((entry) => ({
      name: entry.name,
      description: entry.description,
      input: entry.input,
      call: async (args, signal) => callSetiTool(entry, task.id, args, signal),
    })),
  )
}

/** Every session gets the seti server; its tools depend on the agent's Seti control level. */
export function sessionSetiServers(task: Task): Record<string, McpServerConfig> {
  noteProcessControl(task)
  return { [SETI_SERVER]: setiMcpServer(task) }
}

const ASK_AT_ONCE =
  'When a task needs access you lack (an MCP server, a host, an API key, a shared tool), call request_change ' +
  'for it at once and carry on with what you can do meanwhile; the user answers with one tap and pastes a key ' +
  'there, never in chat. Do not search memory, transcripts or the filesystem for how it was done before.'

const SHARED_TOOLS =
  'A script of yours that other agents would reuse can become a shared tool the same way: request_change, ' +
  'kind shared_tool.'

const CONTEXT: Record<SetiControlLevel, string | null> = {
  off: null,
  self:
    'Your Seti control is Self: the seti MCP tools read Seti (context packs, channels, repos, MCP ' +
    'servers, plugins, the sandbox allowlist) and change only you (title, colour, repos, ' +
    'directories, PRs, packs, role, channel subscriptions). They never reach other agents or shared ' +
    'settings.',
  full:
    'You have Seti control: the seti MCP tools act on Seti as the EA does (agents, transcripts, ' +
    'group chat, PRs, packs, channels, plugins, MCP servers, settings). Use them for ' +
    'Seti actions instead of asking @ea.',
}

/** What the agent's system prompt says its seti tools can do, by its Seti control level. */
export async function setiToolsContext(taskId: string): Promise<string | null> {
  const task = await tasks.get(taskId)
  const context = task === undefined ? null : CONTEXT[task.seti_control]
  return context === null ? null : `${context} ${ASK_AT_ONCE} ${SHARED_TOOLS}`
}
