import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import type { AccessItem, TaskAccessInput, TaskAccessView } from '@seti/shared'
import { openSeedDb } from './db.js'
import { paths } from './env.js'
import { expect } from './fixtures.js'
import { settled } from './phone-layout.js'

/** A rule as long as the ones Always allow saves for a shell loop. */
export const LONG_RULE = `Bash(for n in 2255 2784 2238 2412; do gh pr view $n -R example/dashboard --json title,state; done${' && echo checked'.repeat(12)})`

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** The box of the nth item once open animations end, failing when it is not laid out. */
export async function boxOf(items: Locator, n: number): Promise<Box> {
  await settled(items.page())
  const box = await items.nth(n).boundingBox()
  if (box === null) {
    throw new Error(`item ${String(n)} has no box`)
  }
  return box
}

/** An idle agent with no repo, so no turn ever starts. */
export async function seedIdleAgent(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, title, paths.checkout, new Date().toISOString())
  await db.close()
  return id
}

/** Gives the agent its own rules: two allows, the long one first, an ask and a deny. */
export async function seedOwnRules(request: APIRequestContext, id: string): Promise<void> {
  const rules = [
    { behavior: 'allow', rule: LONG_RULE },
    { behavior: 'allow', rule: 'Read' },
    { behavior: 'ask', rule: 'Bash(git push:*)' },
    { behavior: 'deny', rule: 'Bash(rm -rf:*)' },
  ]
  for (const data of rules) {
    expect((await request.post(`/api/tasks/${id}/permissions/rules`, { data })).ok()).toBe(true)
  }
}

const mcp = (n: number): AccessItem => ({
  kind: 'mcp',
  id: `e2e-server-${String(n).padStart(2, '0')}`,
  name: `e2e-server-${String(n).padStart(2, '0')}`,
  detail: null,
  enabled: n % 3 === 0,
  default_enabled: false,
  override: null,
  jump_for: [],
  missing_key: [],
  in_set: false,
  session: null,
})

/**
 * Serves the agent's access as eleven MCP servers, a third of them on, and applies each PUT to
 * that list, so the dialog's layout and bulk buttons run without probing real servers.
 */
export async function serveManyMcpServers(page: Page, id: string): Promise<{ puts: () => number }> {
  let view: TaskAccessView = {
    task_id: id,
    sandboxed: true,
    items: Array.from({ length: 11 }, (_, i) => mcp(i + 1)),
    profile: { id: 'default', name: 'Default' },
    hosts: [],
    seti_control: 'self',
    aws: { state: 'no_role', profile: 'Default' },
    github: { state: 'none' },
  }
  let puts = 0
  await page.route(`**/api/tasks/${id}/access`, async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as TaskAccessInput
      puts += 1
      view = {
        ...view,
        items: view.items.map((item) =>
          item.kind === body.kind && item.id === body.id
            ? { ...item, enabled: body.enabled ?? item.default_enabled }
            : item,
        ),
      }
    }
    await route.fulfill({ json: { data: view, meta: {} } })
  })
  return { puts: () => puts }
}
