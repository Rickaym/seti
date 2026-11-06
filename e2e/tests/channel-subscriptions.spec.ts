import { createHmac, randomUUID } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import type { ChannelSecret, ChannelSubscription } from '@seti/shared'
import { openAgentSettings } from './support/agent-settings.js'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test } from './support/fixtures.js'

/** An idle task that wakes on updates; nothing in its transcript and no agent running. */
async function seedTask(title: string, pinned = false): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date().toISOString()
  await db.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, status, input_mode, pinned, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 0, 'idle', 'wake', ${pinned ? 'true' : 'false'}, ?, ?)`,
    id,
    title,
    paths.checkout,
    ts,
    ts,
  )
  await db.close()
  return id
}

async function newChannel(request: APIRequestContext, name: string): Promise<ChannelSecret> {
  const response = await request.post('/api/channels', { data: { name, preset: 'generic', subscribe_ea: false } })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { data: ChannelSecret }).data
}

test('subscribes an agent from the channel card, pinned agents first, and filters its events', async ({
  page,
  request,
}) => {
  const tag = randomUUID().slice(0, 8)
  const pinned = await seedTask(`E2E pinned watcher ${tag}`, true)
  await seedTask(`E2E plain ${tag}`)
  const { channel } = await newChannel(request, `E2E alerts ${tag}`)
  try {
    await page.goto('/#settings/channels')
    const card = page.getByRole('main').getByRole('region', { name: `E2E alerts ${tag}` })
    const subscribers = card.getByRole('list', { name: `E2E alerts ${tag} subscribers` })
    await expect(card.getByRole('switch', { name: `E2E alerts ${tag} EA delivery` })).not.toBeChecked()

    await card.getByRole('button', { name: 'Agent' }).click()
    const offered = page.getByRole('list', { name: 'Agents to subscribe' }).getByRole('button')
    await expect(offered.first()).toHaveText(/E2E pinned watcher/)
    await offered.filter({ hasText: `E2E pinned watcher ${tag}` }).click()
    // The closed picker hands focus back to its button when it unmounts, closing any newer popover.
    await expect(offered).toHaveCount(0)
    await expect(subscribers).toContainText(`E2E pinned watcher ${tag}`)
    await expect(subscribers).toContainText('Nothing yet')

    await card.getByRole('button', { name: `E2E pinned watcher ${tag} event filter` }).click()
    await page.getByRole('textbox', { name: 'Event kinds' }).fill('Deploy, disk')
    await page.getByRole('button', { name: 'Apply' }).click()
    await expect(card.getByRole('button', { name: `E2E pinned watcher ${tag} event filter` })).toHaveText('2 kinds')
    await expect
      .poll(async () => (await apiData<ChannelSubscription[]>(request, `/tasks/${pinned}/channels`))[0]?.events)
      .toEqual(['deploy', 'disk'])

    await card.getByRole('switch', { name: `E2E alerts ${tag} EA delivery` }).click()
    await expect(card.getByRole('switch', { name: `E2E alerts ${tag} EA delivery` })).toBeChecked()
    await card.getByRole('button', { name: `Unsubscribe E2E pinned watcher ${tag}` }).click()
    await expect(subscribers).not.toContainText(`E2E pinned watcher ${tag}`)
    expect(await apiData<ChannelSubscription[]>(request, `/tasks/${pinned}/channels`)).toEqual([])
  } finally {
    await request.delete(`/api/channels/${channel.id}`)
  }
})

test("the EA row toggles between reporting and acting on a channel's alerts", async ({ page, request }) => {
  const tag = randomUUID().slice(0, 8)
  const { channel } = await newChannel(request, `E2E asks ${tag}`)
  const eaMode = async () =>
    (await apiData<ChannelSubscription[]>(request, '/ea/channels')).find((sub) => sub.channel_id === channel.id)?.mode
  try {
    await page.goto('/#settings/channels')
    const card = page.getByRole('main').getByRole('region', { name: `E2E asks ${tag}` })
    const act = card.getByRole('button', { name: 'Auto act', exact: true })
    await expect(act).toHaveCount(0)

    await card.getByRole('switch', { name: `E2E asks ${tag} EA delivery` }).click()
    await expect(act).toHaveAttribute('aria-pressed', 'false')
    expect(await eaMode()).toBe('report')

    await act.click()
    await expect(act).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(eaMode).toBe('act')

    await page.reload()
    await expect(act).toHaveAttribute('aria-pressed', 'true')
    await act.click()
    await expect(act).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(eaMode).toBe('report')
  } finally {
    await request.delete(`/api/channels/${channel.id}`)
  }
})

test('subscribes from agent details, and a delivered event lands in the transcript and wakes it', async ({
  page,
  request,
  baseURL,
}) => {
  const tag = randomUUID().slice(0, 8)
  const id = await seedTask(`E2E channel agent ${tag}`)
  const { channel, secret } = await newChannel(request, `E2E deploys ${tag}`)
  try {
    await page.goto(`/#agents/${id}`)
    const main = page.getByRole('main')
    await openAgentSettings(page, 'Team')
    const channels = page.getByTestId('task-channels')
    await expect(channels).toContainText('None')
    await channels.getByRole('button', { name: 'Add channel' }).click()
    await page.getByRole('list', { name: 'Channels to subscribe' }).getByText(`E2E deploys ${tag}`).click()
    await expect(channels).toContainText(`E2E deploys ${tag}`)
    await expect(page.getByRole('combobox', { name: 'Updates' })).toHaveText('Wake the agent')
    await page.keyboard.press('Escape')

    const body = JSON.stringify({
      title: 'Deploy to production failed',
      message: 'Step migrate exited 1',
      type: 'deploy',
    })
    const signature = `sha256=${createHmac('sha256', secret ?? '')
      .update(body)
      .digest('hex')}`
    const sent = await fetch(new URL(channel.path, baseURL), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-seti-signature': signature },
      body,
    })
    expect(sent.status).toBe(200)
    expect(await sent.json()).toEqual({
      data: { status: 'accepted', reason: `sent to E2E channel agent ${tag}` },
      meta: {},
    })

    const card = main.locator('[data-kind="input"][data-input="channel"]')
    await expect(card).toContainText('Deploy to production failed')
    await expect(card).toContainText(`E2E deploys ${tag}, from E2E deploys ${tag} deploy`)
    await expect(card).toContainText('Step migrate exited 1')
    await expect(main.getByText('Seti started a turn to hand the agent 1 update')).toBeVisible()

    await page.goto('/#settings/channels')
    const channelCard = page.getByRole('main').getByRole('region', { name: `E2E deploys ${tag}` })
    await channelCard.getByRole('button', { name: `E2E deploys ${tag} activity` }).click()
    await expect(channelCard.getByTestId('delivery-routes')).toContainText(`E2E channel agent ${tag}: delivered`)

    await page.goto(`/#agents/${id}`)
    await openAgentSettings(page, 'Team')
    await channels.getByRole('button', { name: `Unsubscribe from E2E deploys ${tag}` }).click()
    await expect(channels).toContainText('None')
    expect(await apiData<ChannelSubscription[]>(request, `/tasks/${id}/channels`)).toEqual([])
  } finally {
    await request.delete(`/api/channels/${channel.id}`)
  }
})
