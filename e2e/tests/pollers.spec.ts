import { randomUUID } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ChannelInfo, ChannelSources, PollerChannelInfo } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test } from './support/fixtures.js'

/** An idle task that wakes on updates; nothing in its transcript and no agent running. */
async function seedTask(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date().toISOString()
  await db.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, status, input_mode, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 0, 'idle', 'wake', ?, ?)`,
    id,
    title,
    paths.checkout,
    ts,
    ts,
  )
  await db.close()
  return id
}

/** A JSON API on this machine whose releases the test changes between polls. */
async function releaseApi(releases: { tag: string; name: string }[]): Promise<{ host: string; close: () => void }> {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: { releases } }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    host: `127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: () => server.close(),
  }
}

test('creates a poller from a preset, test runs it, and its events reach a subscribed agent', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000)
  const tag = randomUUID().slice(0, 8)
  const releases = [{ tag: 'v1.0.0', name: 'First release' }]
  const api = await releaseApi(releases)
  const agent = await seedTask(`E2E release watcher ${tag}`)
  const name = `E2E releases ${tag}`
  let pollerId = ''
  try {
    await page.goto('/#settings/channels')
    const main = page.getByRole('main')
    await main.getByRole('button', { name: 'New', exact: true }).click()
    await page
      .getByRole('list', { name: 'Channel sources' })
      .getByRole('button', { name: /Poller/ })
      .click()

    const dialog = page.getByRole('dialog', { name: 'New poller' })
    await expect(dialog.getByRole('combobox', { name: 'Template' })).toHaveText('HTTP JSON')
    const script = dialog.getByRole('textbox', { name: 'Script' })
    await expect(dialog.locator('[data-code-editor] .tok-keyword').first()).toBeVisible()
    const sources = await apiData<ChannelSources>(request, '/channels/sources')
    const template = sources.pollers.find((entry) => entry.id === 'poller-templates.http_json')
    await script.fill(
      (template?.script ?? '')
        .replace('https://api.example.com/items', `http://${api.host}/releases`)
        .replace("const LIST = 'items'", "const LIST = 'data.releases'")
        .replace("const KEY = 'id'", "const KEY = 'tag'")
        .replace("const TITLE = 'title'", "const TITLE = 'name'"),
    )
    await dialog.getByRole('button', { name: 'Test run' }).click()
    await expect(dialog.getByTestId('poller-test-status')).toContainText('not on the allowed hosts')

    await dialog.getByRole('textbox', { name: 'Extra hosts' }).fill(api.host)
    await dialog.getByRole('button', { name: 'Test run' }).click()
    await expect(dialog.getByTestId('poller-test-status')).toHaveText(/^1 item in/)
    await expect(dialog.getByRole('list', { name: 'Test items' })).toContainText('v1.0.0First release')

    await dialog.getByRole('textbox', { name: 'Name' }).fill(name)
    await expect(dialog.getByRole('switch', { name: 'EA delivery' })).not.toBeChecked()
    await dialog.getByRole('button', { name: 'Create' }).click()
    await expect(dialog).toBeHidden()

    const card = main.getByRole('region', { name })
    await expect(card.getByTestId('poller-status')).toHaveText(/^(Pending|OK)$/)
    const listed = await apiData<ChannelInfo[]>(request, '/channels')
    pollerId = listed.find((info) => info.name === name)?.id ?? ''
    expect(pollerId).not.toBe('')
    // A new poller runs at once; that run records the items already there as its baseline.
    await expect
      .poll(async () => (await apiData<PollerChannelInfo>(request, `/channels/pollers/${pollerId}`)).poller.last_run_at)
      .not.toBeNull()
    const subscribed = await request.post(`/api/channels/${pollerId}/subscriptions`, {
      data: { target: 'task', task_id: agent },
    })
    expect(subscribed.ok()).toBe(true)

    await card.getByRole('button', { name: 'Poll' }).click()
    await expect(card.getByTestId('poller-status')).toHaveText('OK')
    await expect(card.getByTestId('schedule-on-time')).toHaveText('100%')
    await expect(card).toContainText('1 run in 7 days, 100% on time')
    const activity = card.getByRole('button', { name: `${name} activity` })
    await expect(activity).toHaveAttribute('aria-expanded', 'false')
    await expect(card.getByRole('list', { name: `${name} runs` })).toHaveCount(0)
    await activity.click()
    await expect(card.getByRole('list', { name: `${name} runs` })).toContainText('1 item, 0 events')

    releases.push({ tag: 'v1.1.0', name: 'Second release' })
    await card.getByRole('button', { name: 'Poll' }).click()
    await expect(
      card
        .getByRole('list', { name: `${name} runs` })
        .getByRole('listitem')
        .first(),
    ).toContainText('2 items, 1 event')
    await expect(card.getByRole('list', { name: `${name} events` })).toContainText('Second release')
    await expect(card.getByTestId('delivery-routes').first()).toContainText(`E2E release watcher ${tag}: delivered`)

    await page.goto(`/#agents/${agent}`)
    const input = page.getByRole('main').locator('[data-kind="input"][data-input="channel"]')
    await expect(input).toContainText('Second release')

    const saved = await apiData<PollerChannelInfo>(request, `/channels/pollers/${pollerId}`)
    expect(saved.poller).toMatchObject({ status: 'ok', extra_hosts: [api.host], keys: 2 })
  } finally {
    api.close()
    if (pollerId !== '') {
      await request.delete(`/api/channels/${pollerId}`)
    }
  }
})

test('pauses a poller from its card and edits it without a preset', async ({ page, request }) => {
  const tag = randomUUID().slice(0, 8)
  const name = `E2E paused ${tag}`
  const response = await request.post('/api/channels/pollers', {
    data: { name, script: 'export default async () => []', subscribe_ea: false },
  })
  expect(response.ok()).toBe(true)
  const created = ((await response.json()) as { data: PollerChannelInfo }).data
  try {
    await page.goto('/#settings/channels')
    const card = page.getByRole('main').getByRole('region', { name })
    await card.getByRole('switch', { name: `${name} schedule` }).click()
    await expect(card.getByTestId('poller-status')).toHaveText('Paused')

    await card.getByRole('button', { name: 'Edit' }).click()
    const dialog = page.getByRole('dialog', { name: `Edit ${name}` })
    await expect(dialog.getByRole('combobox', { name: 'Template' })).toHaveCount(0)
    await dialog.getByRole('spinbutton', { name: 'Interval' }).fill('15')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()
    await expect(card).toContainText('Every 15 min')
    const saved = await apiData<PollerChannelInfo>(request, `/channels/pollers/${created.id}`)
    expect(saved.poller).toMatchObject({ enabled: false, interval_s: 900 })
  } finally {
    await request.delete(`/api/channels/${created.id}`)
  }
})
