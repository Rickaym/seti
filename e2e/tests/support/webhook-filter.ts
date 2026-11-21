import { createHmac, randomUUID } from 'node:crypto'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import type { ChannelInfo, ChannelSecret, WebhookChannelInfo } from '@seti/shared'
import { openSeedDb } from './db.js'
import { paths } from './env.js'
import { apiData, expect } from './fixtures.js'
import { expectFitsPhone } from './phone-layout.js'

/** A click on desktop, a tap on a phone. */
type Press = (target: Locator) => Promise<void>

interface Flow {
  page: Page
  request: APIRequestContext
  baseURL: string
  press: Press
  phone: boolean
}

const DROP_DEPLOYS = "export default function filter(event) {\n  return event.event !== 'deploy'\n}\n"

/** An idle agent that wakes on updates, with nothing running. */
async function seedAgent(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date().toISOString()
  await db.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, status, input_mode, pinned, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 0, 'idle', 'wake', false, ?, ?)`,
    id,
    title,
    paths.checkout,
    ts,
    ts,
  )
  await db.close()
  return id
}

async function post<T>(request: APIRequestContext, url: string, data: object): Promise<T> {
  const response = await request.post(`/api${url}`, { data })
  expect(response.ok(), `POST /api${url}`).toBe(true)
  return ((await response.json()) as { data: T }).data
}

async function webhook(request: APIRequestContext, id: string): Promise<WebhookChannelInfo> {
  const found = (await apiData<ChannelInfo[]>(request, '/channels')).find((info) => info.id === id)
  if (found?.source !== 'webhook') {
    throw new Error(`No webhook ${id}`)
  }
  return found
}

async function deliver(baseURL: string, created: ChannelSecret, payload: object): Promise<void> {
  const body = JSON.stringify(payload)
  const signature = `sha256=${createHmac('sha256', created.secret ?? '')
    .update(body)
    .digest('hex')}`
  const sent = await fetch(new URL(created.channel.path, baseURL), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-seti-signature': signature },
    body,
  })
  expect(sent.status).toBe(200)
}

/** Writes the filter in the editor, tries it on a pasted sample, and saves it. */
async function writeFilter({ page, press, phone }: Flow, card: Locator, name: string): Promise<void> {
  await press(card.getByRole('button', { name: 'Add', exact: true }))
  const dialog = page.getByRole('dialog', { name: `Filter for ${name}` })
  await dialog.getByRole('textbox', { name: 'Filter code' }).fill(DROP_DEPLOYS)
  await press(dialog.getByText('Sample', { exact: true }))
  await dialog.getByRole('textbox', { name: 'Sample body' }).fill('{"type":"deploy","title":"Sample deploy"}')
  await press(dialog.getByRole('button', { name: 'Test' }))
  const rows = dialog.getByRole('list', { name: 'Filter test rows' }).getByRole('listitem')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toHaveAttribute('data-outcome', 'dropped')
  await expect(rows.first()).toContainText('Sample deploy')
  if (phone) {
    await expectFitsPhone(page, 'the filter editor with a test result')
  }
  await press(dialog.getByRole('button', { name: 'Save' }))
  await expect(dialog).toHaveCount(0)
  await expect(card.getByRole('switch', { name: `${name} filter on` })).toBeChecked()
}

/** Tests the saved code again, now on the two recent deliveries. */
async function retest({ page, press }: Flow, card: Locator, name: string): Promise<void> {
  await press(card.getByRole('button', { name: 'Edit', exact: true }))
  const dialog = page.getByRole('dialog', { name: `Filter for ${name}` })
  await press(dialog.getByRole('button', { name: 'Test' }))
  const rows = dialog.getByRole('list', { name: 'Filter test rows' }).getByRole('listitem')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toHaveAttribute('data-outcome', 'kept')
  await expect(rows.nth(0)).toContainText('Disk full')
  await expect(rows.nth(1)).toHaveAttribute('data-outcome', 'dropped')
  await expect(rows.nth(1)).toContainText('Deploy shipped')
  await press(dialog.getByRole('button', { name: 'Cancel' }))
  await expect(dialog).toHaveCount(0)
}

/**
 * A filter written on the webhook's card drops deploy events: of two signed deliveries, one
 * reaches the subscribed agent and one shows as filtered out, and Test tells the same story.
 */
export async function filterDropsOneEventType(flow: Flow): Promise<void> {
  const { page, request, baseURL, press, phone } = flow
  const tag = randomUUID().slice(0, 8)
  const name = `E2E filtered ${tag}`
  const agent = await seedAgent(`E2E filter watcher ${tag}`)
  const created = await post<ChannelSecret>(request, '/channels', { name, preset: 'generic', subscribe_ea: false })
  const id = created.channel.id
  try {
    await post(request, `/channels/${id}/subscriptions`, { target: 'task', task_id: agent })
    await page.goto(`/#settings/channels/${id}`)
    const card = page.getByRole('main').getByRole('region', { name })
    await expect(card.getByTestId('filter-counts')).toHaveCount(0)
    await writeFilter(flow, card, name)

    await deliver(baseURL, created, { type: 'deploy', title: 'Deploy shipped' })
    await deliver(baseURL, created, { type: 'disk', title: 'Disk full' })
    const [kept, dropped] = (await webhook(request, id)).deliveries
    expect(kept).toMatchObject({ status: 'accepted', filter: { outcome: 'kept', event: 'disk' } })
    expect(kept?.routes).toMatchObject([{ target: 'task', task_id: agent }])
    expect(dropped).toMatchObject({ status: 'filtered', routes: [], filter: { outcome: 'dropped', event: 'deploy' } })

    await page.reload()
    await expect(card.getByTestId('filter-counts')).toHaveText('Last 24 hours: 1 kept, 1 dropped')
    await press(card.getByRole('button', { name: `${name} activity` }))
    const log = card.getByRole('list', { name: `${name} deliveries` }).getByRole('listitem')
    await expect(log.nth(0)).toContainText('accepted')
    await expect(log.nth(1)).toContainText('filtered out')
    await expect(log.nth(1)).toContainText('deploy: Deploy shipped')
    if (phone) {
      await expectFitsPhone(page, 'a webhook card with a filter and its activity')
    }
    await retest(flow, card, name)
    expect((await webhook(request, id)).filter).toMatchObject({
      enabled: true,
      failures: 0,
      day: { kept: 1, dropped: 1 },
    })
  } finally {
    await request.delete(`/api/channels/${id}`)
  }
}
