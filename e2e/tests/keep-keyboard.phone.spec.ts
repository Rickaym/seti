import { randomUUID } from 'node:crypto'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'

async function seedTask(): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const at = new Date().toISOString()
  await db.idleTask(id, 'Phone keyboard', paths.checkout, at)
  await db.message(id, 'prompt', JSON.stringify({ text: 'Seeded keyboard prompt.' }), at)
  await db.close()
  return id
}

test('tapping Send on a phone keeps the reply box focused, so the keyboard stays up', async ({ page }) => {
  const id = await seedTask()
  await page.route(`**/api/tasks/${id}/messages`, async (route) => {
    await (route.request().method() === 'POST' ? route.fulfill({ json: { data: {}, meta: {} } }) : route.fallback())
  })
  await page.goto(`/#agents/${id}`)
  await expect(page.getByText('Seeded keyboard prompt.')).toBeVisible()
  const reply = page.getByRole('combobox', { name: 'Reply' })
  const send = page.getByRole('button', { name: 'Send', exact: true })

  await reply.tap()
  await reply.fill('First of two')
  await send.tap()
  await expect(reply).toHaveValue('')
  await expect(reply).toBeFocused()

  await reply.pressSequentially('Second of two')
  await send.tap()
  await expect(reply).toHaveValue('')
  await expect(reply).toBeFocused()
})

test('tapping Send in the group chat on a phone keeps its box focused', async ({ page }) => {
  await page.route('**/api/team/messages', async (route) => {
    await (route.request().method() === 'POST' ? route.fulfill({ json: { data: {}, meta: {} } }) : route.fallback())
  })
  await page.goto('/#agents')
  await page.getByRole('banner').getByTestId('team-chat-toggle').tap()
  const sheet = page.getByRole('dialog', { name: 'Group chat' })
  const composer = sheet.getByRole('combobox', { name: 'Message the group' })

  await composer.tap()
  await composer.fill('One for the group')
  await sheet.getByRole('button', { name: 'Send to the group' }).tap()
  await expect(composer).toHaveValue('')
  await expect(composer).toBeFocused()
})
