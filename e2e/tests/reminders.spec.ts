import { randomUUID } from 'node:crypto'
import type { ChannelInfo, ReminderChannelInfo } from '@seti/shared'
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

const SCRIPT = `export default ({ state }) => {
  const count = (state ?? 0) + 1
  return { message: 'Review the open pull requests, round ' + count, state: count }
}`

test('creates a reminder, test runs it, and its message reaches a subscribed agent', async ({ page, request }) => {
  test.setTimeout(60_000)
  const tag = randomUUID().slice(0, 8)
  const agent = await seedTask(`E2E reviewer ${tag}`)
  const name = `E2E nudge ${tag}`
  let reminderId = ''
  try {
    await page.goto('/#settings/channels')
    const main = page.getByRole('main')
    await main.getByRole('button', { name: 'New', exact: true }).click()
    await page
      .getByRole('list', { name: 'Channel sources' })
      .getByRole('button', { name: /Reminder/ })
      .click()

    const dialog = page.getByRole('dialog', { name: 'New reminder' })
    await dialog.getByRole('textbox', { name: 'Script' }).fill("import fs from 'node:fs'\nexport default () => 'x'")
    await dialog.getByRole('button', { name: 'Test run' }).click()
    await expect(dialog.getByTestId('reminder-test-status')).toContainText('cannot import node:fs')

    await dialog.getByRole('textbox', { name: 'Script' }).fill(SCRIPT)
    await dialog.getByRole('button', { name: 'Test run' }).click()
    await expect(dialog.getByTestId('reminder-test-status')).toContainText('Would deliver')
    await expect(dialog.getByRole('region', { name: 'Test run result' })).toContainText(
      'Review the open pull requests, round 1',
    )

    await dialog.getByRole('textbox', { name: 'Name' }).fill(name)
    await dialog.getByRole('spinbutton', { name: 'Interval' }).fill('2')
    await dialog.getByRole('combobox', { name: 'Interval unit' }).selectOption('hours')
    await dialog.getByRole('button', { name: 'Create' }).click()
    await expect(dialog).toBeHidden()

    const card = main.getByRole('region', { name })
    await expect(card.getByTestId('reminder-status')).toHaveText('Pending')
    await expect(card).toContainText('Every 2 h')
    reminderId = (await apiData<ChannelInfo[]>(request, '/channels')).find((info) => info.name === name)?.id ?? ''
    expect(reminderId).not.toBe('')
    const subscribed = await request.post(`/api/channels/${reminderId}/subscriptions`, {
      data: { target: 'task', task_id: agent },
    })
    expect(subscribed.ok()).toBe(true)

    await card.getByRole('button', { name: 'Run' }).click()
    await expect(card.getByTestId('reminder-status')).toHaveText('OK')
    await card.getByRole('button', { name: `${name} activity` }).click()
    await expect(card.getByRole('list', { name: `${name} runs` })).toContainText(
      'Review the open pull requests, round 1',
    )
    await expect(card.getByTestId('delivery-routes').first()).toContainText(`E2E reviewer ${tag}: delivered`)

    await card.getByRole('switch', { name: `${name} schedule` }).click()
    await expect(card.getByTestId('reminder-status')).toHaveText('Paused')

    await page.goto(`/#agents/${agent}`)
    const input = page.getByRole('main').locator('[data-kind="input"][data-input="channel"]')
    await expect(input).toContainText('Review the open pull requests, round 1')

    const saved = await apiData<ReminderChannelInfo>(request, `/channels/reminders/${reminderId}`)
    expect(saved.reminder).toMatchObject({ enabled: false, interval_s: 7200, next_run_at: null })
  } finally {
    if (reminderId !== '') {
      await request.delete(`/api/channels/${reminderId}`)
    }
  }
})
