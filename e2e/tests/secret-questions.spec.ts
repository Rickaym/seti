import { MERGE_PROMPT, MERGE_QUESTION, MERGE_RECOMMENDED } from './support/fake-question.js'
import { expect, test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import {
  agentQuestions,
  askingAgent,
  lastReply,
  questionsSection,
  sectionCount,
  sentLine,
  sentToast,
} from './support/questions.js'
import { expectKeptOut, fixtureValue, SECRET_NAME, SECRET_PURPOSE, secretAgent } from './support/secret-questions.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('an agent asks for a secret and gets only the path of the file the user filled', async ({ page, request }) => {
  const asker = await secretAgent(request, 'Speech')
  const merger = await askingAgent(request, 'Merger', MERGE_PROMPT)
  expect(asker.blocked).toBe(`Asks a question: the secret ${SECRET_NAME}, ${SECRET_PURPOSE}`)

  await page.goto('/#agents')
  await questionsSection(page).click()
  await expect(page.getByRole('heading', { name: 'Questions' })).toBeVisible()

  const secret = agentQuestions(page, asker)
  await expect(secret).toContainText(SECRET_NAME)
  await expect(secret).toContainText(SECRET_PURPOSE)
  await expect(secret).toContainText('gives the agent its path, never the value')
  const field = secret.getByLabel(`Value of ${SECRET_NAME}`)
  await expect(field).toHaveAttribute('type', 'password')
  const value = fixtureValue()
  await field.fill(value)
  await secret.getByRole('button', { name: 'Show value' }).click()
  await expect(field).toHaveAttribute('type', 'text')
  await secret.getByRole('button', { name: 'Hide value' }).click()
  await expect(field).toHaveAttribute('type', 'password')

  const merge = agentQuestions(page, merger)
  await expect(merge.getByRole('radio', { name: /^Squash/ })).toHaveAttribute('aria-checked', 'true')
  await expect(merge.getByRole('radio', { name: /^Squash/ })).toContainText('Recommended')
  await expect(sentLine(page)).toHaveText('2 of 2 answered')
  await page.getByRole('button', { name: 'Submit all' }).click()

  await expect(sentToast(page, 'Sent 2 answers. Going on:')).toBeVisible()
  await expect(page).toHaveURL(/#agents$/)
  await expect
    .poll(async () => lastReply(request, merger.id))
    .toBe(`Got your answers. ${MERGE_QUESTION} ${MERGE_RECOMMENDED}`)
  await expectKeptOut(page, request, asker, value)
})

test('Questions stays in the sidebar with nothing open, and the palette opens it', async ({ page }) => {
  await page.goto('/#agents')
  await expect(sectionCount(questionsSection(page))).toHaveCount(0)
  await questionsSection(page).click()
  await expect(page.getByRole('heading', { name: 'Questions' })).toBeVisible()
  await page.goto('/#home')
  await page.keyboard.press('Control+k')
  const search = page.getByRole('dialog', { name: 'Search Seti' }).getByRole('combobox')
  await expect(search).toBeFocused()
  await search.fill('Questions')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#questions$/)
  await expect(page.getByRole('heading', { name: 'Questions' })).toBeVisible()
})
