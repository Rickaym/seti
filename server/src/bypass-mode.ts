import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { Task } from '@seti/shared'
import { regimeOfTask, type ApprovalRegime } from './approval-ceiling.js'
import { PERMISSION_MODE } from './config.js'

/** Claude Code's mode for each regime; `default` runs what the rules allow and asks for the rest. */
const CLAUDE_MODES: Record<ApprovalRegime, PermissionMode> = {
  user: 'default',
  rules: 'default',
  classifier: PERMISSION_MODE,
  bypass: 'bypassPermissions',
}

/**
 * The mode a Claude agent's tool calls run in: bypass while its Bypass lasts, `default` while it
 * is held to a Codex agent's approvals, else Seti's default.
 */
export const permissionModeOf = async (task: Pick<Task, 'id' | 'runtime' | 'bypass_until'>): Promise<PermissionMode> =>
  CLAUDE_MODES[await regimeOfTask(task)]
