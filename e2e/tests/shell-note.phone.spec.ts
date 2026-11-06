import { expect, test, unique } from './support/fixtures.js'
import { startAgent } from './support/grid.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('on a phone a ! result notes it goes with the next message, then drops the note', async ({ page, request }) => {
  const id = await startAgent(request, unique('Phone shell note'))
  await page.goto(`/#agents/${id}`)
  const reply = page.getByRole('combobox', { name: 'Reply' })
  await reply.fill('!echo hi')
  await page.getByRole('button', { name: 'Run shell command', exact: true }).tap()
  const entry = page.locator('[data-kind="shell"]').filter({ hasText: 'echo hi' })
  const note = entry.getByTestId('shell-delivery')
  await expect(note).toHaveText('Goes to the agent with your next message')
  await expectFitsPhone(page, 'shell result note')

  await reply.fill('thanks')
  await page.getByRole('button', { name: 'Send', exact: true }).tap()
  await expect(note).toHaveCount(0)
})
