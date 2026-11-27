import type {
  CanUseTool,
  HookCallback,
  HookCallbackMatcher,
  HookJSONOutput,
  McpServerConfig,
  PermissionResult,
} from '@anthropic-ai/claude-agent-sdk'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js'
import type { NodeAnswer, Task } from '@seti/shared'
import { subagentRules } from './house-rules.js'
import { nodeLink } from './node-link.js'
import { bashGuard, guardRefuses } from './permission-guard.js'
import { ASK_TIMEOUT_S, asRecord, repeatHooks } from './repeat-hooks.js'
import { folderConfigHook } from './runtimes/claude/config-hook.js'
import { editNoteHooks } from './runtimes/claude/edit-note-hooks.js'
import type { DefaultHost, DefaultShapes } from './runtimes/registry.js'
import { sandboxHooks } from './sandbox.js'
import { guardScope } from './session-options.js'
import { shadowHooks } from './shadow-hooks.js'

/**
 * Claude Code adds what a PreCompact hook answers to the summary's instructions, beside any the
 * user gave /compact. The task's instructions are read when it compacts, so edits apply at once.
 */
const compactHook = (instructions: () => Promise<string | null>): HookCallbackMatcher => ({
  hooks: [
    async () => {
      const kept = await instructions()
      return kept === null ? {} : { systemMessage: kept }
    },
  ],
})

type EditNotes = ReturnType<typeof editNoteHooks>

/** Bash calls it noted at once, so a call nobody asks about is not kept for long. */
const SHELL_DIRS_KEPT = 50

/**
 * The folder the agent's shell is in for each Bash call, as the PreToolUse hook reports it, kept
 * until the call is asked about; the shell keeps a `cd` of an earlier call.
 */
function shellDirs() {
  const dirs = new Map<string, string>()
  const hook: HookCallback = async (input) => {
    if (input.hook_event_name === 'PreToolUse') {
      dirs.set(input.tool_use_id, input.cwd)
      const [oldest] = dirs.keys()
      if (dirs.size > SHELL_DIRS_KEPT && oldest !== undefined) {
        dirs.delete(oldest)
      }
    }
    return Promise.resolve({})
  }
  const take = (id: string) => {
    const dir = dirs.get(id)
    dirs.delete(id)
    return dir
  }
  return { matcher: { matcher: 'Bash', hooks: [hook] } satisfies HookCallbackMatcher, take }
}

type ShellDirs = ReturnType<typeof shellDirs>

/**
 * Decides each tool call the runtime would ask about by asking the control plane, and keeps its
 * note of the user's edits for the agent once the call has run.
 */
const decideByAsking =
  (taskId: string, session: AbortSignal, edits: EditNotes, dirs: ShellDirs): CanUseTool =>
  async (tool, input, { signal, ...options }) => {
    const both = AbortSignal.any([signal, session])
    const cwd = dirs.take(options.toolUseID)
    const asked = { tool, input, options, ...(cwd === undefined ? {} : { cwd }) }
    const { result, context } = await nodeLink.ask(taskId, 'permission.ask', asked, both)
    edits.keep(options.toolUseID, context)
    // The control plane answered with what canUseToolFor decided.
    return result as PermissionResult
  }

const UNCHECKED = 'Seti could not check its review rules, so it held this call back. Tell the user.'

const UNCHECKED_PUSH = 'Seti could not check where this command pushes, so it held it back. Tell the user.'

const held = (reason: string): HookJSONOutput => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
})

/**
 * A PreToolUse hook that holds each MCP call a review rule names until the user answers; when the
 * control plane cannot say, the call is held back.
 */
function reviewHook(taskId: string, session: AbortSignal): HookCallbackMatcher {
  const hook: HookCallback = async (input, _toolUseId, { signal }) => {
    if (input.hook_event_name !== 'PreToolUse') {
      return {}
    }
    const call = { tool: input.tool_name, id: input.tool_use_id, input: asRecord(input.tool_input) }
    try {
      const { output } = await nodeLink.ask(taskId, 'review.ask', call, AbortSignal.any([signal, session]))
      // The control plane answered with what reviewCall decided.
      return output as HookJSONOutput
    } catch (e) {
      process.stderr.write(`review hook: task ${taskId}: ${String(e)}\n`)
      return held(UNCHECKED)
    }
  }
  return { matcher: 'mcp__.*', hooks: [hook], timeout: ASK_TIMEOUT_S }
}

/**
 * A PreToolUse hook that holds a command pushing outside the user's organisations until the user
 * answers, in Bypass too; when the control plane cannot say, the command is held back.
 */
function pushHook(taskId: string, session: AbortSignal): HookCallbackMatcher {
  const hook: HookCallback = async (input, _toolUseId, { signal }) => {
    if (input.hook_event_name !== 'PreToolUse') {
      return {}
    }
    const call = { tool: input.tool_name, id: input.tool_use_id, input: asRecord(input.tool_input), cwd: input.cwd }
    try {
      const { output } = await nodeLink.ask(taskId, 'push.ask', call, AbortSignal.any([signal, session]))
      // The control plane answered with what pushCall decided.
      return output as HookJSONOutput
    } catch (e) {
      process.stderr.write(`push hook: task ${taskId}: ${String(e)}\n`)
      return held(UNCHECKED_PUSH)
    }
  }
  return { matcher: 'Bash', hooks: [hook], timeout: ASK_TIMEOUT_S }
}

/**
 * Hooks of every task: the guards, a sandboxed one's WebFetch allowlist, rules for subagents, and
 * the task's compaction instructions.
 */
function sessionHooks(task: Task, sandboxed: boolean, session: AbortSignal): DefaultShapes['hooks'] {
  const taskId = task.id
  const scope = guardScope(task, sandboxed)
  const refused = async (command: string, reason: string) =>
    nodeLink.journal(taskId, { type: 'guard.refused', command, reason })
  const guard = bashGuard(scope, refused)
  const hosts = async () => (await nodeLink.ask(taskId, 'sandbox.hosts', {})).hosts
  const sandbox = sandboxed ? (sandboxHooks(hosts).PreToolUse ?? []) : []
  const repeat = repeatHooks({
    taskId,
    session,
    refused: (tool, input) => guardRefuses(tool, input, scope),
    ask: async (call, results, signal) => nodeLink.ask(taskId, 'repeat.ask', { ...call, results }, signal),
  })
  const PreToolUse = [
    guard,
    ...sandbox,
    reviewHook(taskId, session),
    pushHook(taskId, session),
    ...(repeat.PreToolUse ?? []),
  ]
  const instructions = async () => (await nodeLink.ask(taskId, 'hook.compact', {})).instructions
  return {
    ...repeat,
    PreToolUse,
    SubagentStart: [subagentRules()],
    PreCompact: [compactHook(instructions)],
    ...(sandboxed ? { ConfigChange: [folderConfigHook] } : {}),
  }
}

type ListedServer = NodeAnswer<'tools.list'>['servers'][number]

/** Serves a listed server's tools in this process; each call runs on the control plane. */
function hostedServer(taskId: string, { name, tools }: ListedServer): McpServerConfig {
  const instance = new McpServer({ name, version: '1.0.0' }, { capabilities: { tools: {} } })
  // The control plane listed them with an MCP client of the server itself.
  const listed = { tools } as ListToolsResult
  instance.server.setRequestHandler(ListToolsRequestSchema, () => listed)
  instance.server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
    const call = { server: name, tool: params.name, args: params.arguments ?? {} }
    // The control plane answered with the server's own MCP result.
    return (await nodeLink.ask(taskId, 'tool.call', call, signal)).result as CallToolResult
  })
  return { type: 'sdk', name, instance }
}

type Hooks = DefaultShapes['hooks']

/** Both sets of hooks, each event's matchers in order. */
function withHooks(first: Hooks, second: Hooks): Hooks {
  const events = [...new Set([...Object.keys(first), ...Object.keys(second)])] as (keyof Hooks)[]
  return Object.fromEntries(events.map((event) => [event, [...(first[event] ?? []), ...(second[event] ?? [])]]))
}

/**
 * What Seti answers for a task's session while its turns wait, until the session ends. Seti's own
 * permission evaluator runs beside, in shadow, and changes no answer.
 */
export async function sessionHost(task: Task, sandboxed: boolean, session: AbortSignal): Promise<DefaultHost> {
  const { servers } = await nodeLink.ask(task.id, 'tools.list', {})
  const shadow = shadowHooks(task, sandboxed, session)
  const edits = editNoteHooks()
  const dirs = shellDirs()
  const notes = { PostToolUse: edits.PostToolUse, PostToolUseFailure: edits.PostToolUseFailure }
  const own = withHooks(sessionHooks(task, sandboxed, session), { PreToolUse: [dirs.matcher] })
  return {
    decide: shadow.observe(decideByAsking(task.id, session, edits, dirs)),
    hooks: withHooks(withHooks(own, notes), shadow.hooks),
    toolServers: Object.fromEntries(servers.map((server) => [server.name, hostedServer(task.id, server)])),
  }
}
