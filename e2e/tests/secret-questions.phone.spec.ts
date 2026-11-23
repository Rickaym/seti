import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { agentQuestions, openRequestsFromMenu, sentLine, expectNoSentToast } from './support/questions.js'
import { expectKeptOut, fixtureValue, SECRET_NAME, secretAgent } from './support/secret-questions.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('on a phone the user enters a secret on the Requests page and the agent gets its path', async ({
  page,
  request,
}) => {
  const asker = await secretAgent(request, 'Phone speech')
  await page.goto('/#agents')
  await openRequestsFromMenu(page)
  await expect(page.getByRole('heading', { name: 'Requests' })).toBeVisible()
  await expectFitsPhone(page, 'Requests with a secret')

  const secret = agentQuestions(page, asker)
  const value = fixtureValue()
  await secret.getByLabel(`Value of ${SECRET_NAME}`).fill(value)
  await secret.getByRole('button', { name: 'Show value' }).tap()
  await expect(secret.getByLabel(`Value of ${SECRET_NAME}`)).toHaveAttribute('type', 'text')
  await expect(sentLine(page)).toHaveText('1 of 1 answered')
  await page.getByRole('button', { name: 'Submit all' }).tap()

  await expect(page).toHaveURL(/#agents$/)
  await expectNoSentToast(page)
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
  await expectKeptOut(page, request, asker, value)
})
