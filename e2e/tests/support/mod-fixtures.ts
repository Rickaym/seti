import fs from 'node:fs'
import path from 'node:path'
import { type APIRequestContext, expect } from '@playwright/test'
import type { Envelope, ModInstallPreview } from '@seti/shared'
import { paths } from './env.js'

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/mods')

/** A fresh copy of a fixture package, as an agent would leave it in its workspace. */
export function fixtureCopy(name: string): string {
  const folder = fs.mkdtempSync(path.join(paths.root, `mod-${name}-`))
  fs.cpSync(path.join(FIXTURES, name), folder, { recursive: true })
  return folder
}

/** Installs a package folder through the user's routes, as the install dialog does. */
export async function installFolder(
  request: APIRequestContext,
  folder: string,
  connections: Record<string, string> = {},
): Promise<ModInstallPreview> {
  expect((await request.put('/api/mod-admin/dev-mode', { data: { on: true } })).status()).toBe(200)
  const checked = await request.post('/api/mod-admin/preview', { data: { source: { kind: 'folder', path: folder } } })
  expect(checked.status(), await checked.text()).toBe(200)
  const preview = ((await checked.json()) as Envelope<ModInstallPreview>).data
  const installed = await request.post('/api/mod-admin/install', {
    data: { mod_id: preview.mod_id, hash: preview.hash, connections },
  })
  expect(installed.status(), await installed.text()).toBe(200)
  return preview
}

/** Uninstalls the mod with its data if a test left it, and turns Developer mode back off. */
export async function removeMod(request: APIRequestContext, id: string): Promise<void> {
  await request.post(`/api/mod-admin/mods/${id}/uninstall`, { data: { delete_data: true } })
  expect((await request.put('/api/mod-admin/dev-mode', { data: { on: false } })).status()).toBe(200)
}
