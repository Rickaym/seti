import { randomUUID } from 'node:crypto'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'

test('Enter sends a reply and leaves the box focused for the next one', async ({ page }) => {
  const db = openSeedDb()
  const id = randomUUID()
  const at = new Date().toISOString()
  await db.idleTask(id, 'Desktop keyboard', paths.checkout, at)
  await db.message(id, 'prompt', JSON.stringify({ text: 'Seeded desktop prompt.' }), at)
  await db.close()
  await page.route(`**/api/tasks/${id}/messages`, async (route) => {
    await (route.request().method() === 'POST' ? route.fulfill({ json: { data: {}, meta: {} } }) : route.fallback())
  })
  await page.goto(`/#agents/${id}`)
  await expect(page.getByText('Seeded desktop prompt.')).toBeVisible()
  const reply = page.getByRole('combobox', { name: 'Reply' })

  await reply.fill('First of two')
  await reply.press('Enter')
  await expect(reply).toHaveValue('')
  await expect(reply).toBeFocused()
  await reply.pressSequentially('Second of two')
  await reply.press('Enter')
  await expect(reply).toHaveValue('')
  await expect(reply).toBeFocused()
})
