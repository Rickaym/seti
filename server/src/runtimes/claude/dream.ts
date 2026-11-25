import path from 'node:path'
import type { HookCallback, HookInput, HookJSONOutput, Options } from '@anthropic-ai/claude-agent-sdk'
import { claudeToolCall } from '@seti/shared'
import { CLAUDE_HOME } from '../../config.js'
import type { Launcher } from '../../launcher.js'
import { projectSlug } from '../../sandbox-mounts.js'
import type { DreamHost, DreamSpec, DreamTool } from '../adapter.js'
import { claudeLaunch, ownMemory } from './realise.js'
import { inProcessServer } from './tool-server.js'

/** Claude Code's tools a dream gets; the gate decides each call to them. */
const DREAM_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']

/** Where Claude Code keeps an agent's memory: its project folder's memory, by working folder. */
export const claudeMemory = (cwd: string) => path.join(CLAUDE_HOME, 'projects', projectSlug(cwd), 'memory')

const decision = (permissionDecision: 'allow' | 'deny', reason?: string): HookJSONOutput => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision,
    ...(reason === undefined ? {} : { permissionDecisionReason: reason }),
  },
})

/** The gate as a PreToolUse hook on every tool: it allows or denies each call, never asks. */
const gateHook =
  (host: DreamHost): HookCallback =>
  async (input) =>
    Promise.resolve(gateAnswer(host, input))

function gateAnswer(host: DreamHost, input: HookInput): HookJSONOutput {
  if (input.hook_event_name !== 'PreToolUse') {
    return {}
  }
  try {
    const refusal = host.gate(claudeToolCall(input.tool_use_id, input.tool_name, input.tool_input))
    return refusal === null ? decision('allow') : decision('deny', refusal)
  } catch (e) {
    process.stderr.write(`dream gate: ${String(e)}\n`)
    return decision('deny', 'Seti could not check this call, so it is refused.')
  }
}

/** A host tool as an in-process MCP tool whose answer is text. */
const hostTool = (entry: DreamTool) => ({
  name: entry.name,
  description: entry.description,
  input: entry.input,
  call: async (args: unknown) => ({ content: [{ type: 'text' as const, text: await entry.call(args) }] }),
})

/** The host's tools by server, as Claude Code names them: mcp__<server>__<tool>. */
function hostServers(tools: readonly DreamTool[]) {
  const servers = [...new Set(tools.map((entry) => entry.server))]
  return Object.fromEntries(
    servers.map((server) => [
      server,
      inProcessServer(server, tools.filter((entry) => entry.server === server).map(hostTool)),
    ]),
  )
}

/**
 * Options for a dream: a new Claude Code session that resumes and saves nothing, loads no user or
 * project settings, hooks, plugins or MCP servers but the host's, runs its own memory
 * consolidation never, and denies every call the gate does not allow.
 */
export function dreamOptions(
  spec: DreamSpec,
  launcher: Launcher,
  host: DreamHost,
  abortController: AbortController,
): Options {
  const named = host.tools.map((entry) => `mcp__${entry.server}__${entry.name}`)
  return {
    cwd: spec.cwd,
    ...(spec.dirs.length === 0 ? {} : { additionalDirectories: [...spec.dirs] }),
    model: spec.model,
    tools: DREAM_TOOLS,
    allowedTools: [...DREAM_TOOLS, ...named],
    permissionMode: 'dontAsk',
    mcpServers: hostServers(host.tools),
    strictMcpConfig: true,
    settingSources: [],
    settings: { autoDreamEnabled: false, ...ownMemory(spec.cwd) },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.append },
    persistSession: false,
    maxTurns: spec.maxTurns,
    maxBudgetUsd: spec.budgetUsd,
    hooks: { PreToolUse: [{ hooks: [gateHook(host)] }] },
    abortController,
    ...claudeLaunch(launcher),
    env: { ...launcher.env, CLAUDE_CODE_SHELL: '/bin/bash', SHELL: '/bin/bash' },
  }
}
