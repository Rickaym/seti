import { randomUUID } from 'node:crypto'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'

test('opens the group chat as a full-height sheet on a phone', async ({ page }) => {
  await page.goto('/#agents')
  const viewport = page.viewportSize() ?? { width: 0, height: 0 }
  await page.getByRole('banner').getByTestId('team-chat-toggle').click()
  const sheet = page.getByRole('dialog', { name: 'Group chat' })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('combobox', { name: 'Message the group' })).toBeVisible()
  await expect
    .poll(async () => {
      const found = await sheet.boundingBox()
      return found === null ? null : { width: Math.round(found.width), height: Math.round(found.height) }
    })
    .toEqual({ width: viewport.width, height: viewport.height })
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(scroll).toBe(0)
  await sheet.getByRole('button', { name: 'Close group chat' }).click()
  await expect(sheet).toBeHidden()
})

test('the group chat starts closed after a reload and closes on navigation', async ({ page }) => {
  await page.goto('/#agents')
  const sheet = page.getByRole('dialog', { name: 'Group chat' })
  await page.getByRole('banner').getByTestId('team-chat-toggle').tap()
  await expect(sheet).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('seti.team.open'))).toBe('1')

  await page.reload()
  await expect(page.getByRole('main').getByRole('heading').first()).toBeVisible()
  await expect(sheet).toBeHidden()

  await page.getByRole('banner').getByTestId('team-chat-toggle').tap()
  await expect(sheet).toBeVisible()
  await page.evaluate(() => {
    window.location.hash = '#context'
  })
  await expect(page).toHaveURL(/#context$/)
  await expect(sheet).toBeHidden()
})

test('Copy reply shows without hover on a phone and copies the message source', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const text = `**Phone copy** ${randomUUID().slice(0, 8)}\n\n- one\n- two`
  const db = openSeedDb()
  const id = randomUUID()
  const at = new Date().toISOString()
  const handle = `pc${Date.now().toString(36)}`
  await db.idleTask(id, 'E2E phone copy', paths.checkout, at)
  await db.run(`INSERT INTO team_member (task_id, handle, muted, updated_at) VALUES (?, ?, 0, ?)`, id, handle, at)
  await db.run(
    `INSERT INTO team_message (author_kind, author_task_id, author_handle, text, mentions, created_at)
     VALUES ('task', ?, ?, ?, '[]', ?)`,
    id,
    handle,
    text,
    at,
  )
  await db.close()
  await page.goto('/#agents')
  await page.getByRole('banner').getByTestId('team-chat-toggle').tap()
  const sheet = page.getByRole('dialog', { name: 'Group chat' })
  const message = sheet.getByTestId('team-message').filter({ hasText: 'Phone copy' })
  const copy = message.getByRole('button', { name: 'Copy reply' })
  await expect(copy).toHaveCSS('opacity', '1')
  expect((await copy.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await copy.tap()
  await expect.poll(async () => page.evaluate(async () => navigator.clipboard.readText())).toBe(text)
})
