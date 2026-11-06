import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ModInfo, ModInstallPreview, ModList } from '@seti/shared'
import { expect } from 'vitest'
import { createApp } from './app.js'
import { USER_AUTH } from './test-auth.js'

/** The app every mod route test calls, made once so its hooks register once. */
export const app = createApp()

export async function request(route: string, method = 'GET', body?: unknown, auth: Record<string, string> = USER_AUTH) {
  return app.request(`/api${route}`, {
    method,
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

export async function data<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await request(route, method, body)
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { data: T }).data
}

/** The status and error detail of a request expected to fail. */
export async function refused(route: string, method: string, body: unknown, auth?: Record<string, string>) {
  const res = await request(route, method, body, auth)
  const json = (await res.json()) as { error?: { detail: string } }
  return { status: res.status, detail: json.error?.detail ?? '' }
}

/** A mod manifest a test package holds; extra keys replace the defaults. */
export const manifestOf = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id.charAt(0).toUpperCase() + id.slice(1),
  version: '1.0.0',
  seti: '^1.1',
  description: `The ${id} mod, as the tests build it.`,
  capabilities: [{ name: 'net.fetch', hosts: ['api.example.com'] }, { name: 'storage' }],
  ...extra,
})

/** Writes a package folder; call again on the same folder to change it. */
export function writePackage(manifest: Record<string, unknown>, dir?: string): string {
  const folder = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mod-install-'))
  fs.writeFileSync(path.join(folder, 'seti-mod.json'), JSON.stringify(manifest))
  return folder
}

export async function preview(folder: string): Promise<ModInstallPreview> {
  return data<ModInstallPreview>('/mod-admin/preview', 'POST', { source: { kind: 'folder', path: folder } })
}

/** Previews and installs a package folder, returning the installed mod as the list shows it. */
export async function install(folder: string, connections: Record<string, string> = {}): Promise<ModInfo> {
  const checked = await preview(folder)
  const list = await data<ModList>('/mod-admin/install', 'POST', {
    mod_id: checked.mod_id,
    hash: checked.hash,
    connections,
  })
  return list.mods.find((mod) => mod.id === checked.mod_id) ?? expect.fail(`${checked.mod_id} is not listed`)
}

export const listed = async (id: string): Promise<ModInfo | undefined> =>
  (await data<ModList>('/mods')).mods.find((mod) => mod.id === id)
