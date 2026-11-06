import { expect, test, toasts } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { startSessionAgent, transcript } from './support/restart.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('the session restart fits a phone, from the cog to the toast', async ({ page, request }) => {
  const { id, session } = await startSessionAgent(request)
  await page.goto(`/#agents/${id}`)
  await expect(transcript(page)).toContainText(`Session ${session}, resumed none`)
  await page.getByRole('main').getByRole('button', { name: 'Agent settings' }).tap()
  const restart = page.getByRole('button', { name: 'Restart session' })
  await restart.scrollIntoViewIfNeeded()
  await expect(restart).toBeInViewport()
  await expectFitsPhone(page, 'agent details with the session buttons')
  await restart.tap()
  const dialog = page.getByRole('dialog', { name: 'Restart session' })
  await expect(dialog).toContainText('The conversation is kept')
  await expectFitsPhone(page, 'restart session confirmation')
  await dialog.getByRole('button', { name: 'Restart', exact: true }).tap()
  await expect(toasts(page).filter({ hasText: 'Session restarted' })).toBeVisible()
  await expect(transcript(page)).toContainText('Session restarted; the conversation continues')
})
