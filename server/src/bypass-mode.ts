import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { bypassOn, type Task } from '@seti/shared'
import { PERMISSION_MODE } from './config.js'

/** The mode the agent's tool calls run in: bypass while its Bypass lasts, else Seti's default. */
export const permissionModeOf = (task: Pick<Task, 'bypass_until'>): PermissionMode =>
  bypassOn(task.bypass_until) ? 'bypassPermissions' : PERMISSION_MODE
