import fs from 'node:fs'
import path from 'node:path'
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk'
import { heldFolderSettings } from '../../folder-settings-trust.js'
import { settingsRules } from '../../inherited-rules.js'
import type { PermissionSettings } from '../../permission-policy.js'

/**
 * How a Claude Code agent takes its folder's settings when an agent's session could have written
 * some of them: their allow rules held back, everything else kept.
 */
export interface FolderSettings {
  /** It loads the folder's local settings: only a file that was there and is not held. */
  local: boolean
  /** Ask rules over a held settings file's allow rules, and a held local file's ask and deny rules. */
  rules: Pick<PermissionSettings, 'ask' | 'deny'>
  /** The servers of a held `.mcp.json`, which stay off. */
  disabledServers: string[]
}

const rulesOf = (file: string, behavior: string) =>
  settingsRules(file)
    .filter((rule) => rule.behavior === behavior)
    .map((rule) => rule.rule)

function serverNames(file: string): string[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    const servers = typeof parsed === 'object' && parsed !== null && 'mcpServers' in parsed ? parsed.mcpServers : null
    return typeof servers === 'object' && servers !== null ? Object.keys(servers) : []
  } catch {
    return []
  }
}

/** Nothing is held, so the session's key stays as it was before folder settings could be held. */
export const holdsNothing = (settings: FolderSettings): boolean =>
  settings.rules.ask.length === 0 && settings.rules.deny.length === 0 && settings.disabledServers.length === 0

/** The folder settings a Claude Code agent in `cwd` starts with. */
export async function folderSettingsOf(cwd: string): Promise<FolderSettings> {
  const held = await heldFolderSettings(cwd)
  const project = path.join(cwd, '.claude', 'settings.json')
  const local = path.join(cwd, '.claude', 'settings.local.json')
  const localHeld = held.has('.claude/settings.local.json')
  return {
    local: fs.existsSync(local) && !localHeld,
    rules: {
      ask: [
        ...(held.has('.claude/settings.json') ? rulesOf(project, 'allow') : []),
        ...(localHeld ? rulesOf(local, 'ask') : []),
      ],
      deny: localHeld ? rulesOf(local, 'deny') : [],
    },
    disabledServers: held.has('.mcp.json') ? serverNames(path.join(cwd, '.mcp.json')) : [],
  }
}

/**
 * Keeps a sandboxed session on the folder settings it started with: a change to the folder's
 * project or local settings, by the agent or anyone, applies from the next session.
 */
export const folderConfigHook: HookCallbackMatcher = {
  hooks: [
    async (input) =>
      Promise.resolve(
        input.hook_event_name === 'ConfigChange' &&
          (input.source === 'project_settings' || input.source === 'local_settings')
          ? { decision: 'block' as const, reason: "The folder's settings apply from the agent's next session." }
          : {},
      ),
  ],
}
