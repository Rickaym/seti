import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import type { CredentialProfile } from '@seti/shared'
import { openAgentSettings } from './agent-settings.js'
import { openSeedDb } from './db.js'
import { paths } from './env.js'
import { expect, unique } from './fixtures.js'

/** A new credential whose set turns AWS on, and an idle sandboxed agent that uses it. */
export async function agentOnCredential(request: APIRequestContext, name: string) {
  const response = await request.post('/api/credentials/profiles', { data: { name: unique(name) } })
  const profile = ((await response.json()) as { data: CredentialProfile }).data
  await request.put(`/api/credentials/profiles/${profile.id}/access`, {
    data: { kind: 'aws', id: 'aws', enabled: true },
  })
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date().toISOString()
  await db.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, sandbox, status, created_at, updated_at, profile_id)
     VALUES (?, ?, NULL, ?, 0, 1, 'idle', ?, ?, ?)`,
    id,
    `E2E follows ${id.slice(0, 8)}`,
    paths.checkout,
    ts,
    ts,
    profile.id,
  )
  await db.close()
  return { id, profile }
}

/** Opens the agent's access dialog from its settings. */
export async function openAccess(page: Page, id: string) {
  await page.goto(`/#agents/${id}`)
  await openAgentSettings(page, 'Access')
  await page.getByRole('button', { name: 'Edit access' }).click()
  const access = page.getByRole('dialog', { name: /^Access of / })
  await expect(access).toBeVisible()
  return access
}
