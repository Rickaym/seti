import {
  AGENT_SETTING_ENTRIES,
  AGENT_SETTING_TABS,
  COMMAND_SETTINGS,
  parseSettingCommand,
  RESERVED_COMMAND_NAMES,
  settingCommandRefusal,
  settingCommands,
  type AgentCapabilities,
} from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { tasks } from './db.js'
import { slashRefusal } from './mods/commands.js'
import { agentCapabilities } from './runtimes/capabilities.js'
import { USER_AUTH } from './test-auth.js'

await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-setting-commands-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
})

const TASK = 'setting-commands-agent'
await tasks.insert({ id: TASK, title: 'Commands', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })

const app = createApp({ access: null, verify: null })
const HEADERS = { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' }

const names = (caps: AgentCapabilities | null) => settingCommands(caps).map((command) => command.name)

describe("an agent's setting commands", () => {
  it('names each command once and reserves exactly those names', () => {
    const all = COMMAND_SETTINGS.map((entry) => entry.command.name)
    expect(new Set(all).size).toBe(all.length)
    const byName = (a: string, b: string) => a.localeCompare(b)
    expect([...RESERVED_COMMAND_NAMES].toSorted(byName)).toEqual(all.toSorted(byName))
    expect(all.toSorted(byName)).toEqual([
      'access',
      'archive',
      'bypass',
      'credential',
      'dream',
      'mcp',
      'rename',
      'restart',
      'sandbox',
      'settings',
    ])
  })

  it('lists every setting once, each tab of the settings with its rows', () => {
    const ids = AGENT_SETTING_ENTRIES.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const tab of AGENT_SETTING_TABS) {
      expect(AGENT_SETTING_ENTRIES.some((entry) => entry.place === tab)).toBe(true)
    }
    expect(AGENT_SETTING_ENTRIES.filter((entry) => entry.place === 'dialog').map((entry) => entry.id)).toEqual([
      'mcp',
      'control',
    ])
  })

  it("lists only what the agent's runtime declares it can take", () => {
    expect(names(agentCapabilities('claude'))).toHaveLength(10)
    expect(names(agentCapabilities('codex'))).not.toEqual(expect.arrayContaining(['sandbox']))
    expect(names(agentCapabilities('codex'))).not.toContain('bypass')
    expect(names(agentCapabilities('codex'))).not.toContain('dream')
    expect(names(agentCapabilities('codex'))).toContain('mcp')
  })

  it('reads a setting command only as the whole line from its start, in any case', () => {
    expect(parseSettingCommand('/archive')?.setting.id).toBe('archive')
    expect(parseSettingCommand('  /MCP github on')).toMatchObject({ setting: { id: 'mcp' }, args: 'github on' })
    expect(parseSettingCommand('please /archive')).toBeNull()
    expect(parseSettingCommand('!archive')).toBeNull()
    expect(parseSettingCommand('/archived')).toBeNull()
    expect(parseSettingCommand('/compact')).toBeNull()
  })

  it('refuses a setting command sent to the agent as a prompt, so it never reaches the runtime', async () => {
    expect(settingCommandRefusal('/archive')).toContain('never goes to the agent')
    expect(slashRefusal('/sandbox off')).toContain('/sandbox is a Seti command')
    expect(slashRefusal('Archive the old branch')).toBeNull()
    const queued = await app.request(`/api/tasks/${TASK}/messages`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ prompt: '/archive', interrupt: false }),
    })
    expect(queued.status).toBe(400)
    expect((await tasks.get(TASK))?.archived_at).toBeNull()
  })
})
