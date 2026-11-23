import { dreams, idleAgent, lastMemoryActor } from './support/dreams.js'
import { DREAM_SUMMARY } from './support/fake-dream.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone, expectTouchTarget } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('Dream now and its report fit a phone, undo included', async ({ page, request }) => {
  const id = await idleAgent(request)
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'Agent settings' }).tap()
  const dreamNow = dreams(page).getByRole('button', { name: 'Dream now' })
  await dreamNow.scrollIntoViewIfNeeded()
  await expectTouchTarget(dreamNow)
  await dreamNow.tap()
  const last = dreams(page).getByRole('button', { name: 'Last dream' })
  await expect(last).toContainText('done, 1 memory file changed')
  await last.tap()
  await expect(dreams(page)).toContainText(DREAM_SUMMARY)
  await expectFitsPhone(page, 'the last dream with its memory changes')
  const undo = dreams(page).getByRole('button', { name: 'Undo MEMORY.md' })
  await expectTouchTarget(undo)
  await undo.tap()
  await expect.poll(async () => lastMemoryActor(request, id)).toBe('user')
})
