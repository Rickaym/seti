import {
  AGENT_SETTING_ENTRIES,
  AGENT_SETTING_TABS,
  RESERVED_COMMAND_NAMES,
  setiComposerCommands,
  withSetiCommands,
  type AgentCapabilities,
  type ComposerCommand,
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

const names = (caps: AgentCapabilities | null) => setiComposerCommands(caps).map((command) => command.name)

const runtimeCommand = (name: string): ComposerCommand => ({
  name,
  description: `The runtime's ${name}`,
  argument_hint: '',
  aliases: [],
  builtin: true,
  unsupported: null,
})

describe("an agent's Seti commands", () => {
  it('names every command seti: and reserves the names of every setting from mods', () => {
    const all = names(null)
    expect(new Set(all).size).toBe(all.length)
    expect(all.every((name) => name.startsWith('seti:'))).toBe(true)
    expect(all).toEqual(expect.arrayContaining(['seti:access', 'seti:mcp', 'seti:restart', 'seti:memory']))
    expect(all).not.toContain('seti:credential')
    expect([...RESERVED_COMMAND_NAMES]).toEqual(AGENT_SETTING_ENTRIES.map((entry) => entry.id))
  })

  it('lists every setting once, each tab of the settings with its rows', () => {
    const ids = AGENT_SETTING_ENTRIES.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const tab of AGENT_SETTING_TABS) {
      expect(AGENT_SETTING_ENTRIES.some((entry) => entry.place === tab)).toBe(true)
    }
  })

  it("lists only what the agent's runtime declares it can take", () => {
    expect(names(agentCapabilities('codex'))).not.toContain('seti:sandbox')
    expect(names(agentCapabilities('codex'))).not.toContain('seti:bypass')
    expect(names(agentCapabilities('codex'))).toContain('seti:mcp')
    expect(names(agentCapabilities('claude'))).toContain('seti:bypass')
  })

  it("gives the bare names back to the runtime and drops a runtime's own seti: command", () => {
    const merged = withSetiCommands(
      [runtimeCommand('mcp'), runtimeCommand('rename'), runtimeCommand('seti:access')],
      setiComposerCommands(null),
    )
    expect(merged.filter((command) => command.name === 'mcp')).toEqual([runtimeCommand('mcp')])
    expect(merged.filter((command) => command.name === 'rename')).toHaveLength(1)
    expect(merged.filter((command) => command.name === 'seti:access')).toHaveLength(1)
    expect(merged.find((command) => command.name === 'seti:access')?.description).not.toContain("runtime's")
  })

  it('refuses a /seti: line sent to the agent as a prompt; a bare name goes to the runtime', async () => {
    expect(slashRefusal('/seti:sandbox off')).toContain('never goes to the agent')
    expect(slashRefusal('/sandbox off')).toBeNull()
    expect(slashRefusal('Archive the old branch')).toBeNull()
    const queued = await app.request(`/api/tasks/${TASK}/messages`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ prompt: '/seti:archive', interrupt: false }),
    })
    expect(queued.status).toBe(400)
    expect((await tasks.get(TASK))?.archived_at).toBeNull()
  })
})
