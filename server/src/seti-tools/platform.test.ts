import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { asAgent } from '../access.js'
import { tasks } from '../db.js'
import { addMcpServer } from '../mcp-actions.js'
import { setMcpDefault } from '../mcp-selection.js'
import { addDefaultPlugin, setDefaultPluginEnabled } from '../plugins.js'
import { SETI_TOOLS } from './catalog.js'
import { callSetiTool } from './server.js'
import { auditEvents } from '../store/audit.js'
import { setiPlugins } from '../store/plugins.js'

const caller = { id: randomUUID(), title: 'Platform keeper', seti_control: 'full' as const }
await tasks.insert({ ...caller, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })

async function call(name: string, args: object = {}) {
  const entry = SETI_TOOLS.find((tool) => tool.name === name)
  if (entry === undefined) {
    throw new Error(`No seti tool ${name}`)
  }
  const result = await callSetiTool(entry, caller.id, args)
  const text = result.content.map((block) => block.text).join('')
  return { error: result.isError === true, text, json: () => JSON.parse(text) as Record<string, unknown> }
}

function pluginFolder(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `seti-${name}-`))
  fs.mkdirSync(path.join(dir, '.claude-plugin'))
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }))
  return dir
}

const refusal = async (fn: () => Promise<unknown>) =>
  asAgent(caller, fn).then(
    () => null,
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  )

describe('platform tools', () => {
  it('removes a default plugin as the agent', async () => {
    const plugin = await setiPlugins.create({
      name: 'linter',
      version: '1.0.0',
      description: '',
      path: pluginFolder('linter'),
    })
    expect((await call('remove_plugin', { plugin: 'linter' })).error).toBe(false)
    expect(await setiPlugins.get(plugin.id)).toBeUndefined()
    expect(await auditEvents.latest('plugin.default_removed')).toMatchObject({ actor: 'agent', subject_id: plugin.id })
  })

  it('reads and changes the auto-archive rule', async () => {
    expect((await call('set_auto_archive', { enabled: true, days: 9 })).json()).toMatchObject({
      enabled: true,
      days: 9,
    })
    expect((await call('get_archive_settings')).json()).toMatchObject({ settings: { enabled: true, days: 9 } })
    expect(await auditEvents.latest('system.auto_archive_changed')).toMatchObject({ actor: 'agent' })
    expect((await call('run_archive_sweep')).text).toContain('No agent is due')
    expect((await call('set_auto_archive', { delete_after_days: 60 })).json()).toMatchObject({ delete_after_days: 60 })
    expect((await call('set_auto_archive', { delete_after_days: 0 })).json()).toMatchObject({ delete_after_days: null })
  })

  it('lists stale folders and deletes them only when confirmed', async () => {
    const listed = (await call('get_archive_settings', { stale_folders: true })).json()
    expect(listed).toMatchObject({ stale_folders: { days: 7, folders: [] } })
    const unconfirmed = await call('run_archive_sweep', { stale_folders: ['/srv/no-such-stale-folder'] })
    expect(unconfirmed.error).toBe(true)
    expect(unconfirmed.text).toContain('confirm')
    const refused = (
      await call('run_archive_sweep', { stale_folders: ['/srv/no-such-stale-folder'], confirm: true })
    ).json()
    expect(refused).toEqual({
      deleted: [],
      refused: [{ path: '/srv/no-such-stale-folder', reason: 'it is not a stale folder now' }],
    })
  })

  it('mutes an agent and changes where each tier reaches the user', async () => {
    const other = { id: randomUUID(), title: 'Noisy builder' }
    await tasks.insert({ ...other, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
    expect((await call('set_notifications', { task: 'Noisy builder', muted: true })).json()).toMatchObject({
      agent: { id: other.id, muted: true },
      settings: { urgent: 'push', active: 'push', digest: 'brief', passive: 'off' },
    })
    expect(await tasks.get(other.id)).toMatchObject({ notifications_muted: true })
    expect(await auditEvents.latest('task.notifications_changed')).toMatchObject({ actor: 'agent' })
    expect((await call('set_notifications', { active: 'toast' })).json()).toMatchObject({
      settings: { urgent: 'push', active: 'toast', digest: 'brief', passive: 'off' },
    })
    expect(await auditEvents.latest('system.notifications_changed')).toMatchObject({ actor: 'agent' })
    expect((await call('set_notifications', { urgent: 'off' })).error).toBe(true)
    expect((await call('set_notifications', { muted: false })).error).toBe(true)
    expect((await call('set_notifications')).error).toBe(true)
    await call('set_notifications', { active: 'push' })
  })

  it('shows SSH hosts without keys and the security settings', async () => {
    expect((await call('ssh_hosts')).json().keys).toEqual([])
    expect((await call('get_security_settings')).json()).toHaveProperty('policy')
  })
})

describe('what widens agent reach stays the user', () => {
  it('refuses MCP defaults, new MCP servers and turning default plugins on', async () => {
    expect(await refusal(async () => setMcpDefault('github', true))).toContain('Agents cannot change which MCP')
    const input = { name: 'evil', scope: 'user', transport: 'http', url: 'https://example.com/mcp', headers: [] }
    expect(await refusal(async () => addMcpServer(input as Parameters<typeof addMcpServer>[0]))).toContain(
      'Agents cannot add MCP servers',
    )
    expect(await refusal(async () => addDefaultPlugin(pluginFolder('hooks')))).toContain(
      'Agents cannot add default plugins',
    )
    const off = await setiPlugins.create({ name: 'off', version: null, description: '', path: pluginFolder('off') })
    await setiPlugins.setEnabled(off.id, false)
    expect(await refusal(async () => setDefaultPluginEnabled(off.id, true))).toContain(
      'Agents cannot turn default plugins on',
    )
    expect(await setiPlugins.get(off.id)).toMatchObject({ enabled: false })
  })
})
