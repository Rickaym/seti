import { randomUUID } from 'node:crypto'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

const PROMPT = Array.from({ length: 30 }, (_, n) =>
  n % 10 === 3 ? `Step ${String(n)}: ask the agent to read the logs` : `Line ${String(n)} of a long prompt`,
).join('\n')

async function seedTask(): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const at = new Date().toISOString()
  await db.idleTask(id, 'Find on a phone', paths.checkout, at)
  await db.message(id, 'prompt', JSON.stringify({ text: 'Seeded phone find prompt.' }), at)
  await db.close()
  return id
}

test('the Find button opens find and replace in the message box on a phone and it fits', async ({ page }) => {
  const id = await seedTask()
  await page.goto(`/#agents/${id}`)
  await expect(page.getByText('Seeded phone find prompt.')).toBeVisible()
  const main = page.getByRole('main')
  const reply = main.getByRole('combobox', { name: 'Reply' })
  await reply.fill(PROMPT)

  await main.getByRole('button', { name: 'Find in message' }).tap()
  const field = main.getByRole('searchbox', { name: 'Find in message' })
  await expect(field).toBeFocused()
  await field.fill('agent')
  const count = main.getByTestId('message-find-count')
  await expect(count).toHaveText(/^\d of 3$/u)
  const before = await count.textContent()
  await main.getByRole('button', { name: 'Next match' }).tap()
  await expect(count).not.toHaveText(before ?? '')
  await expect(main.getByRole('button', { name: 'Close find' })).toBeInViewport()
  await expectFitsPhone(page, 'find in the message box')

  await main.getByRole('button', { name: 'Replace', exact: true }).tap()
  const replacement = main.getByRole('textbox', { name: 'Replace with' })
  await expect(replacement).toBeVisible()
  await replacement.fill('bot')
  await main.getByRole('button', { name: 'All', exact: true }).tap()
  await expect(count).toHaveText('No matches')
  await expect(reply).toHaveValue(PROMPT.replaceAll('agent', 'bot'))
  await expect(main.getByRole('button', { name: 'All', exact: true })).toBeInViewport()
  await expectFitsPhone(page, 'find and replace in the message box')

  await main.getByRole('button', { name: 'Close find' }).tap()
  await expect(main.getByTestId('message-find')).toHaveCount(0)
  await expect(reply).toBeFocused()
})
