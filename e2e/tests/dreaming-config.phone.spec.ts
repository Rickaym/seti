import { configChanges, subscribers, unusedSubscription } from './support/dream-config.js'
import { dreams, idleAgent } from './support/dreams.js'
import { UNSUBSCRIBE_REASON } from './support/fake-dream.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone, expectTouchTarget } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test("a dream's unsubscribe and its Undo fit a phone", async ({ page, request }) => {
  const id = await idleAgent(request)
  const { name, channel } = await unusedSubscription(request, id)
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'Agent settings' }).tap()
  const dreamNow = dreams(page).getByRole('button', { name: 'Dream now' })
  await dreamNow.scrollIntoViewIfNeeded()
  await dreamNow.tap()
  const last = dreams(page).getByRole('button', { name: 'Last dream' })
  await expect(last).toContainText('done')
  await last.tap()
  await expect(configChanges(page)).toContainText(UNSUBSCRIBE_REASON)
  const undo = configChanges(page).getByRole('button', { name: `Undo unsubscribe from ${name}` })
  await undo.scrollIntoViewIfNeeded()
  await expectTouchTarget(undo)
  await expectFitsPhone(page, "the last dream with a dream's unsubscribe")
  await undo.tap()
  await expect(configChanges(page)).toContainText('Undone')
  expect(await subscribers(request, channel)).toEqual([id])
  await request.delete(`/api/channels/${channel}`)
})
