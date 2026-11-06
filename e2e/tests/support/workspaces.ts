import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { needsYou, type Envelope, type TaskStatus, type Workspace } from '@seti/shared'
import { openSeedDb } from './db.js'
import { paths } from './env.js'
import { expect } from './fixtures.js'

export async function createWorkspace(request: APIRequestContext, name: string): Promise<Workspace> {
  const response = await request.post('/api/workspaces', { data: { name } })
  expect(response.ok(), 'POST /api/workspaces').toBe(true)
  return ((await response.json()) as Envelope<Workspace>).data
}

interface AgentSeed {
  /** Left out, the agent joins the first workspace. */
  workspaceId?: string
  pinned?: boolean
  status?: TaskStatus
}

/** An idle agent with no repo, so no turn ever starts, in the workspace given. */
export async function seedAgent(title: string, seed: AgentSeed = {}): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, title, paths.checkout, new Date().toISOString())
  if (seed.workspaceId !== undefined) {
    await db.run('UPDATE task SET workspace_id = ? WHERE id = ?', seed.workspaceId, id)
  }
  if (seed.pinned === true) {
    await db.run('UPDATE task SET pinned = true WHERE id = ?', id)
  }
  if (seed.status !== undefined) {
    await db.run('UPDATE task SET status = ? WHERE id = ?', seed.status, id)
    if (needsYou(seed.status)) {
      await db.run('UPDATE task SET unseen = true WHERE id = ?', id)
    }
  }
  await db.close()
  return id
}

/** The switcher under the Agents header; its name says the workspace shown. */
export const workspaceSwitcher = (page: Page): Locator => page.getByRole('button', { name: /^Workspace: / })

/** A workspace in the open switcher menu, by the name it shows. */
export const workspaceItem = (page: Page, name: string): Locator =>
  page.getByRole('menuitemradio').filter({ has: page.getByText(name, { exact: true }) })

export async function switchWorkspace(page: Page, name: string): Promise<void> {
  await workspaceSwitcher(page).click()
  await workspaceItem(page, name).click()
  await expect(workspaceSwitcher(page)).toHaveAccessibleName(`Workspace: ${name}`)
  await expect(page.getByRole('menu')).toBeHidden()
}

/** An agent's row in the active list. */
export const agentRow = (page: Page, id: string): Locator => page.locator(`[data-task-id="${id}"]`)
