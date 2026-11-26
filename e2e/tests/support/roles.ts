import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import type { ContextPack } from '@seti/shared'
import { connect } from '../../../server/src/pg.js'
import { RETIRED_ROLES, retireBuiltinRoles } from '../../../server/src/store/schema-roles.js'
import { DATABASE_URL } from './env.js'
import { apiData, expect, unique } from './fixtures.js'

/** A role of the user's own, named "<prefix>-<suffix>"; its text opens with "<name>: <line>". */
export async function newRole(request: APIRequestContext, prefix: string, line: string): Promise<ContextPack> {
  const name = unique(prefix)
  const response = await request.post('/api/context/packs', {
    data: { name, description: '', body: `${name}: ${line}\n- Report in one line.`, kind: 'role' },
  })
  expect(response.ok(), 'POST /api/context/packs').toBe(true)
  return ((await response.json()) as { data: ContextPack }).data
}

/** The role as Seti serves it now. */
export async function roleNow(request: APIRequestContext, id: string): Promise<ContextPack> {
  const found = (await apiData<ContextPack[]>(request, '/context/packs')).find((pack) => pack.id === id)
  if (found === undefined) {
    throw new Error(`Seti serves no role ${id}`)
  }
  return found
}

export async function removePacks(request: APIRequestContext, roles: readonly { id: string }[]): Promise<void> {
  for (const role of roles) {
    await request.delete(`/api/context/packs/${role.id}`)
  }
}

/** Deletes every role, so a spec sees the Context page of an install that has none. */
export async function removeAllRoles(request: APIRequestContext): Promise<void> {
  const packs = await apiData<ContextPack[]>(request, '/context/packs')
  await removePacks(
    request,
    packs.filter((pack) => pack.kind === 'role'),
  )
}

export const rolesSection = (page: Page) => page.getByRole('region', { name: 'Roles' })

/** Opens a role on the Context page and returns its "Runs on" picker. */
export async function openRole(page: Page, name: string) {
  await page.goto('/#context')
  await rolesSection(page)
    .getByRole('button', { name: new RegExp(`^${name}`) })
    .click()
  const picker = page.getByRole('main').getByRole('combobox', { name: 'Runs on' })
  await expect(picker).toBeVisible()
  return picker
}

/** Lead as an upgraded install that used it has it: seeded built in, linked to an agent, retired. */
export async function seedKeptLead(): Promise<{ id: string; task: string }> {
  const lead = RETIRED_ROLES.find((role) => role.name === 'Lead')
  if (lead === undefined) {
    throw new Error('Lead is not among the retired roles')
  }
  const sql = connect(DATABASE_URL, 1)
  const task = randomUUID()
  const at = new Date().toISOString()
  try {
    await sql`DELETE FROM context_pack WHERE id = ${lead.id}`
    await sql`INSERT INTO context_pack (id, name, description, body, kind, builtin, created_at, updated_at)
      VALUES (${lead.id}, ${lead.name}, ${lead.description}, '', 'role', true, ${at}, ${at})`
    await sql`INSERT INTO task (id, title, repo_id, cwd, worktree, status, created_at, updated_at)
      VALUES (${task}, 'Kept lead', NULL, '/tmp', 0, 'idle', ${at}, ${at})`
    await sql`INSERT INTO task_context_pack (task_id, pack_id, linked) VALUES (${task}, ${lead.id}, true)`
    await sql.begin(async (tx) => retireBuiltinRoles(tx))
  } finally {
    await sql.end()
  }
  return { id: lead.id, task }
}
