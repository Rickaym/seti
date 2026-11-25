import type { CanUseTool, HookCallback, Options } from '@anthropic-ai/claude-agent-sdk'
import type { Launcher } from '../../launcher.js'
import type { OneShotRequest } from '../one-shot.js'
import { claudeLaunch } from './realise.js'

const REFUSAL = 'This call offers no tools; answer from what you were given.'

const refuseHook: HookCallback = async () =>
  Promise.resolve({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: REFUSAL },
  })

const refuseCall: CanUseTool = async () => Promise.resolve({ behavior: 'deny', message: REFUSAL })

/**
 * Options for a one-shot: a new Claude Code session with no tools, tool servers, settings,
 * plugins or memory, that keeps nothing on disk, takes one turn and denies any call unasked.
 */
export function oneShotOptions(request: OneShotRequest, launcher: Launcher, abortController: AbortController): Options {
  return {
    cwd: request.cwd,
    model: request.model,
    tools: [],
    allowedTools: [],
    permissionMode: 'dontAsk',
    canUseTool: refuseCall,
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    settings: { autoDreamEnabled: false },
    systemPrompt: request.system,
    persistSession: false,
    maxTurns: 1,
    maxBudgetUsd: request.budgetUsd,
    hooks: { PreToolUse: [{ hooks: [refuseHook] }] },
    abortController,
    ...claudeLaunch(launcher),
    env: { ...launcher.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(request.maxOutputTokens) },
  }
}
