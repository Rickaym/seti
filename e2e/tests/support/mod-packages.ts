import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type APIRequestContext, type Page, expect } from '@playwright/test'

const ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="#2a6f4e"/></svg>'

/** Writes a third-party package folder on this host, as an agent would leave one in its workspace. */
export function writeModPackage(id: string, hosts: string[], dir?: string): string {
  const folder = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), `e2e-mod-${id}-`))
  const name = id.charAt(0).toUpperCase() + id.slice(1)
  const manifest = {
    id,
    name,
    version: dir === undefined ? '1.0.0' : '1.1.0',
    seti: '^1.10',
    author: 'Someone',
    description: 'Shows how a third-party mod installs.',
    icon: 'icon.svg',
    categories: ['integrations'],
    homepage: 'https://example.com/mods',
    capabilities: [{ name: 'net.fetch', hosts }, { name: 'storage' }],
  }
  fs.writeFileSync(path.join(folder, 'seti-mod.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(folder, 'icon.svg'), ICON)
  fs.writeFileSync(path.join(folder, 'README.md'), `# ${name}\n\nKeeps a **tracker** of what agents ship.\n`)
  fs.writeFileSync(path.join(folder, 'CHANGELOG.md'), `# Changelog\n\n## ${manifest.version}\n\nFirst version.\n`)
  return folder
}

/** Uninstalls the mod if a test left it, and turns Developer mode back off. */
export async function cleanUpMod(request: APIRequestContext, id: string): Promise<void> {
  await request.post(`/api/mod-admin/mods/${id}/uninstall`, { data: { delete_data: true } })
  const off = await request.put('/api/mod-admin/dev-mode', { data: { on: false } })
  expect(off.status(), await off.text()).toBe(200)
}

/** Settings, Mods with Developer mode turned on through its toggle. */
export async function openModsInDevMode(page: Page): Promise<void> {
  await page.goto('/#settings/mods')
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: 'Mods', level: 2 })).toBeVisible()
  await expect(main.getByRole('button', { name: 'Add', exact: true })).toHaveCount(0)
  await main.getByRole('button', { name: 'Developer mode' }).click()
  await expect(main.getByRole('button', { name: 'Developer mode' })).toHaveAttribute('aria-pressed', 'true')
}
