import type { APIRequestContext } from '@playwright/test'
import type { ContextPack, Envelope } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { apiData, expect, test, unique } from './support/fixtures.js'

const FEEDBACK = 'User asked to also check the Langfuse traces and skip the ClickUp summary'

async function send<T>(request: APIRequestContext, method: 'post' | 'put', url: string, body: unknown): Promise<T> {
  const response = await request[method](`/api${url}`, { data: body })
  expect(response.ok(), `${method} ${url}`).toBe(true)
  return ((await response.json()) as Envelope<T>).data
}

/** Marks the newest revision of an object as an agent change, as a Seti tool call would record it. */
async function markLatestAsAgent(objectId: string, reason: string): Promise<void> {
  const db = openSeedDb()
  await db.run(
    `UPDATE revision SET actor = 'agent', reason = ? WHERE id = (SELECT MAX(id) FROM revision WHERE object_id = ?)`,
    reason,
    objectId,
  )
  await db.close()
}

test('context pack history shows an agent change and its reason, and opening it clears the marker', async ({
  page,
  request,
}) => {
  const name = unique('e2e-agent-pack')
  const pack = await send<ContextPack>(request, 'post', '/context/packs', {
    name,
    body: 'Check Sentry errors.\nSummarise ClickUp.',
  })
  await send(request, 'put', `/context/packs/${pack.id}`, {
    name,
    body: 'Check Sentry errors.\nCheck Langfuse traces.',
  })
  await markLatestAsAgent(pack.id, FEEDBACK)

  await page.goto('/#context')
  const item = page
    .getByRole('main')
    .getByRole('button', { name: new RegExp(name) })
    .first()
  await expect(item.getByText('changed by agent')).toBeVisible()
  await item.click()
  await expect(page).toHaveURL(new RegExp(`#context/pack:${pack.id}$`))
  await expect(item.getByText('changed by agent')).toBeHidden()

  await page.getByRole('button', { name: 'History', exact: true }).click()
  const entries = page.getByRole('complementary', { name: 'Change history' }).getByRole('listitem')
  await expect(entries).toHaveCount(2)
  const agentChange = entries.first()
  await expect(agentChange).toContainText('agent')
  await expect(agentChange).toContainText('Changed content')
  await expect(agentChange).toContainText(FEEDBACK)
  await expect(agentChange.locator('[data-diff="del"]')).toHaveText(/Summarise ClickUp\./)
  await expect(agentChange.locator('[data-diff="add"]')).toHaveText(/Check Langfuse traces\./)
  await expect(entries.nth(1)).toContainText('Created')
  await expect(entries.nth(1).getByRole('button', { name: /Revert/ })).toHaveCount(0)
})

test('context pack history opens beside the editor and reverts into the form', async ({ page, request }) => {
  const name = unique('e2e-pack-history')
  const pack = await send<ContextPack>(request, 'post', '/context/packs', { name, body: 'First body' })
  await send(request, 'put', `/context/packs/${pack.id}`, { name, body: 'Second body' })

  await page.goto(`/#context/pack:${pack.id}`)
  await expect(page.getByLabel('Pack content')).toHaveValue('Second body')
  await page.getByRole('button', { name: 'History', exact: true }).click()
  const history = page.getByRole('complementary', { name: 'Change history' })
  await expect(history.getByRole('listitem')).toHaveCount(2)
  await history.getByRole('button', { name: /Revert revision/ }).click()
  await page.getByRole('dialog', { name: 'Revert change' }).getByRole('button', { name: 'Revert' }).click()
  await expect(page.getByLabel('Pack content')).toHaveValue('First body')
  await expect(history.getByRole('listitem')).toHaveCount(3)
  expect((await apiData<ContextPack>(request, `/context/packs/${pack.id}`)).body).toBe('First body')
})
