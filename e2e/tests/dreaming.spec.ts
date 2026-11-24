import { dreams, idleAgent, lastMemoryActor } from './support/dreams.js'
import { DREAM_SUMMARY } from './support/fake-dream.js'
import { expect, test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('Dream now tidies the memory, shows the report and undoes a file', async ({ page, request }) => {
  const id = await idleAgent(request)
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'Agent settings' }).click()
  await dreams(page).getByRole('button', { name: 'Dream now' }).click()
  const last = dreams(page).getByRole('button', { name: 'Last dream' })
  await expect(last).toContainText('done, 1 memory file changed')
  await last.click()
  await expect(dreams(page)).toContainText(DREAM_SUMMARY)
  await expect(dreams(page)).toContainText('MEMORY.md: one rule')
  await dreams(page).getByRole('button', { name: 'Undo MEMORY.md' }).click()
  await expect.poll(async () => lastMemoryActor(request, id)).toBe('user')
})
