import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asAgent } from '../access.js'
import { tasks } from '../db.js'
import { SETI_TOOLS } from './catalog.js'
import { callSetiTool } from './server.js'
import { changeMod } from '../mods/actions.js'
import { modHost } from '../mods/bundled.js'
import { auditEvents } from '../store/audit.js'
import { currentSettings } from '../user-settings.js'

const full = { id: randomUUID(), title: 'Mod keeper', seti_control: 'full' as const }
const self = { id: randomUUID(), title: 'Mod watcher', seti_control: 'self' as const }
for (const task of [full, self]) {
  await tasks.insert({ ...task, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
}

async function call(taskId: string, name: string, args: object = {}) {
  const entry = SETI_TOOLS.find((tool) => tool.name === name) ?? expect.fail(`No seti tool ${name}`)
  const result = await callSetiTool(entry, taskId, args)
  return { error: result.isError === true, text: result.content.map((block) => block.text).join('') }
}

afterAll(() => {
  modHost.stopAll()
})

describe('mod tools', () => {
  it('lists mods in seti_overview and lets an agent at Full turn an ordinary one on, as itself', async () => {
    const listed = JSON.parse((await call(full.id, 'seti_overview', { mods: true })).text) as {
      mods: { id: string; manifest?: unknown }[]
    }
    expect(listed.mods.map((mod) => mod.id)).toEqual(
      expect.arrayContaining([
        'catppuccin',
        'github-webhooks',
        'poller-templates',
        'sentry-webhooks',
        'weather',
        'whats-new',
        'sample',
      ]),
    )
    expect(listed.mods.filter((mod) => mod.manifest !== undefined)).toEqual([])
    const turned = await call(full.id, 'set_mod_enabled', { mod: 'Sample', enabled: true })
    expect(turned.error).toBe(false)
    expect(JSON.parse(turned.text)).toEqual({ ok: true, text: 'The Sample mod is on.' })
    await auditEvents.settled()
    expect((await auditEvents.latest('mod.enabled'))?.detail).toMatchObject({ via: 'seti_tools', agent: 'Mod keeper' })
    expect((await call(full.id, 'set_mod_enabled', { mod: 'nothing', enabled: true })).error).toBe(true)
    await call(full.id, 'set_mod_enabled', { mod: 'sample', enabled: false })
  })

  it('lets an agent at Full read and change one Previews format, checked against the manifest', async () => {
    const off = await call(full.id, 'set_mod_enabled', { mod: 'Previews', settings: { pdf: false } })
    expect(JSON.parse(off.text)).toEqual({ ok: true, text: 'In Previews, PDF is false.' })
    await auditEvents.settled()
    expect(await auditEvents.latest('mod.settings_changed')).toMatchObject({
      detail: { mod: 'previews', keys: ['pdf'], via: 'seti_tools', agent: 'Mod keeper' },
    })
    const listed = JSON.parse((await call(full.id, 'seti_overview', { mods: true })).text) as {
      mods: { id: string; settings: { key: string; value: unknown }[]; off_switches: string[] }[]
    }
    const previews = listed.mods.find((mod) => mod.id === 'previews')
    expect(previews?.settings.map(({ key, value }) => [key, value])).toEqual([
      ['pdf', false],
      ['sheets', true],
      ['mermaid', true],
    ])
    expect(previews?.off_switches).toEqual(['pdf'])
    expect((await call(full.id, 'set_mod_enabled', { mod: 'previews', settings: { html: true } })).error).toBe(true)
    const sensitive = await call(full.id, 'set_mod_enabled', { mod: 'html-preview', settings: { pdf: false } })
    expect(sensitive).toMatchObject({ error: true })
    expect(sensitive.text).toContain('Only the user changes the HTML preview mod')
    await call(full.id, 'set_mod_enabled', { mod: 'previews', settings: { pdf: true } })
  })

  it('marks required mods in seti_overview and refuses to turn one off for an agent at Full', async () => {
    const listed = JSON.parse((await call(full.id, 'seti_overview', { mods: true })).text) as {
      mods: { id: string; required: boolean; enabled: boolean }[]
    }
    const required = listed.mods.filter((mod) => mod.required).map((mod) => mod.id)
    expect(required.toSorted((a, b) => a.localeCompare(b))).toEqual([
      'github-webhooks',
      'poller-templates',
      'previews',
      'whats-new',
    ])
    const off = await call(full.id, 'set_mod_enabled', { mod: 'previews', enabled: false })
    expect(off).toMatchObject({ error: true })
    expect(off.text).toContain('The Previews mod is part of Seti and always on')
    expect(modHost.get('previews')?.enabled).toBe(true)
  })

  it('keeps an agent at Self from turning mods on or off', async () => {
    const refused = await asAgent(self, async () => changeMod('sample', { enabled: true })).catch((e: unknown) =>
      e instanceof Error ? e.message : '',
    )
    expect(refused).toBe(
      'Below Seti control Full you cannot turn mods on or off or change them; the user can give you Full in your access',
    )
  })

  it('lets an agent at Full pick a theme a mod that is on adds, with options it offers', async () => {
    const on = await call(full.id, 'set_mod_enabled', { mod: 'catppuccin', enabled: true, theme: 'Catppuccin' })
    expect(JSON.parse(on.text)).toEqual({
      ok: true,
      text: 'The Catppuccin mod is on. Seti shows the Catppuccin theme on every device.',
    })
    expect((await call(full.id, 'set_mod_enabled', { flavour: 'frappe', accent: 'teal' })).error).toBe(false)
    expect((await currentSettings()).theme).toEqual({ id: 'catppuccin.catppuccin', flavour: 'frappe', accent: 'teal' })
    const listed = JSON.parse((await call(full.id, 'seti_overview', { mods: true })).text) as { theme: unknown }
    expect(listed.theme).toEqual({ id: 'catppuccin.catppuccin', flavour: 'frappe', accent: 'teal' })

    const latte = await call(full.id, 'set_mod_enabled', { flavour: 'latte' })
    expect(latte).toMatchObject({ error: true })
    expect(latte.text).toContain('The Catppuccin theme has no flavour latte; it offers frappe, macchiato, mocha')
    await call(full.id, 'set_mod_enabled', { mod: 'catppuccin', enabled: false })
    const off = await call(full.id, 'set_mod_enabled', { theme: 'catppuccin.catppuccin' })
    expect(off.text).toContain('The Catppuccin theme comes from the Catppuccin mod, which is off; turn it on first')
    expect((await call(full.id, 'set_mod_enabled', { theme: 'Default' })).error).toBe(false)
    expect((await call(full.id, 'set_mod_enabled', {})).error).toBe(true)
    await call(full.id, 'set_mod_enabled', { mod: 'catppuccin', enabled: true })
  })
})
