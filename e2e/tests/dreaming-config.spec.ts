import { configChanges, subscribers, unusedSubscription } from './support/dream-config.js'
import { dreams, idleAgent } from './support/dreams.js'
import { UNSUBSCRIBE_REASON } from './support/fake-dream.js'
import { expect, test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('a dream unsubscribes an unused channel, lists it under Tidied, and Undo puts it back', async ({
  page,
  request,
}) => {
  const id = await idleAgent(request)
  const { name, channel } = await unusedSubscription(request, id)
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'Agent settings' }).click()
  await expect(dreams(page)).toContainText('Tidies its memory and unused subscriptions; each change can be undone')
  await dreams(page).getByRole('button', { name: 'Dream now' }).click()
  const last = dreams(page).getByRole('button', { name: 'Last dream' })
  await expect(last).toContainText('done')
  await last.click()
  await expect(configChanges(page)).toContainText(`Unsubscribed from ${name}: ${UNSUBSCRIBE_REASON}`)
  expect(await subscribers(request, channel)).toEqual([])

  await configChanges(page)
    .getByRole('button', { name: `Undo unsubscribe from ${name}` })
    .click()
  await expect(configChanges(page)).toContainText('Undone')
  expect(await subscribers(request, channel)).toEqual([id])
  await request.delete(`/api/channels/${channel}`)
})
