import { createSdkMcpServer, tool, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { SetiControlLevel, Task } from '@seti/shared'
import { z } from 'zod'
import { asAgent } from '../access.js'
import { tasks } from '../db.js'
import { describeIssues } from '../http.js'
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

/** The abort signal of an MCP call, which fires when Claude Code cancels it or the session closes. */
const signalOf = (extra: unknown): AbortSignal | undefined =>
  typeof extra === 'object' && extra !== null && 'signal' in extra && extra.signal instanceof AbortSignal
    ? extra.signal
    : undefined

/** The in-process seti MCP server of one agent's session; every call acts as that agent. */
function setiMcpServer(task: Task): McpServerConfig {
  return createSdkMcpServer({
    name: SETI_SERVER,
    version: '1.0.0',
    tools: sessionTools(task).map((entry) =>
      tool(entry.name, entry.description, entry.input, async (args, extra: unknown) =>
        callSetiTool(entry, task.id, args, signalOf(extra)),
      ),
    ),
  })
}

/** Every session gets the seti server; its tools depend on the agent's Seti control level. */
export function sessionSetiServers(task: Task): Record<string, McpServerConfig> {
  noteProcessControl(task)
  return { [SETI_SERVER]: setiMcpServer(task) }
}

const CONTEXT: Record<SetiControlLevel, string | null> = {
  off: null,
  self:
    'Your Seti control is Self: the seti MCP tools read Seti (context packs, channels, repos, MCP ' +
    'servers, plugins, the sandbox allowlist) and change only you (title, colour, repos, ' +
    'directories, PRs, packs, role, channel subscriptions). They never reach other agents or shared ' +
    'settings. For access you lack (a host, an API key, an MCP server) call request_change; the user ' +
    'answers with one tap and pastes a key there, never in chat.',
  full:
    'You have Seti control: the seti MCP tools act on Seti as the EA does (agents, transcripts, ' +
    'group chat, PRs, packs, channels, plugins, MCP servers, settings). Use them for ' +
    'Seti actions instead of asking @ea. For access you lack (a host, an API key, an MCP server) call ' +
    'request_change; the user answers with one tap and pastes a key there, never in chat.',
}

/** What the agent's system prompt says its seti tools can do, by its Seti control level. */
export async function setiToolsContext(taskId: string): Promise<string | null> {
  const task = await tasks.get(taskId)
  return task === undefined ? null : CONTEXT[task.seti_control]
}
