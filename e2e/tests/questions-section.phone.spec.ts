import { CHECKS_PROMPT, PUSH_PROMPT } from './support/fake-question.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import {
  agentQuestions,
  askingAgent,
  openQuestionsFromMenu,
  questionsDrawer,
  questionsSection,
  sectionCount,
} from './support/questions.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('on a phone the menu lists Questions below Agents, with no count while none are open', async ({ page }) => {
  await page.goto('/#home')
  await page.getByRole('button', { name: 'Menu' }).tap()
  const work = page.getByRole('navigation', { name: 'Sections' }).getByRole('group', { name: 'Work' })
  await expect(work.getByRole('button')).toHaveText(['EA', 'Home', 'Agents', 'Questions'])
  await expect(sectionCount(questionsSection(page))).toHaveCount(0)
  await questionsSection(page).tap()
  await expect(page).toHaveURL(/#questions$/)
  await expect(page.getByRole('heading', { name: 'Questions' })).toBeVisible()
  await expectFitsPhone(page, 'Questions with none open')
  await page.getByRole('button', { name: 'Back', exact: true }).tap()
  await expect(page).toHaveURL(/#home$/)

  await page.evaluate(() => {
    window.location.hash = 'agents/questions'
  })
  await expect(page).toHaveURL(/#questions$/)
  await expect(page.getByRole('heading', { name: 'Questions' })).toBeVisible()
  await page.getByRole('button', { name: 'Back', exact: true }).tap()
  await expect(page).toHaveURL(/#home$/)
})

test('on a phone the menu counts open questions, the Agents list offers none, and the agent opens its drawer', async ({
  page,
  request,
}) => {
  const pusher = await askingAgent(request, 'Phone section pusher', PUSH_PROMPT)
  const checker = await askingAgent(request, 'Phone section checker', CHECKS_PROMPT)
  await page.goto('/#agents')
  const header = page.getByRole('heading', { name: 'Agents', level: 1 }).locator('..')
  await expect(header.getByRole('button')).toHaveCount(3)
  await header.getByRole('button', { name: 'More list actions' }).tap()
  await expect(page.getByRole('menuitemcheckbox', { name: 'Archived' })).toBeVisible()
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveCount(1)
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Menu' }).tap()
  const row = questionsSection(page)
  await expect(sectionCount(row)).toHaveText('3')
  await expect(row).toHaveAccessibleDescription('3 questions wait on you')
  await expectFitsPhone(page, 'menu with the Questions count')
  await row.tap()
  await expect(page).toHaveURL(/#questions$/)
  await expect(agentQuestions(page, pusher)).toBeVisible()
  await expect(agentQuestions(page, checker)).toBeVisible()

  await page.goto(`/#agents/${checker.id}`)
  await page.getByRole('button', { name: 'Answer 2 questions' }).tap()
  const drawer = questionsDrawer(page)
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole('region', { name: /^Questions from / })).toHaveCount(1)

  await page.goto('/#home')
  await openQuestionsFromMenu(page)
  await expect(page).toHaveURL(/#questions$/)
  await page.getByRole('button', { name: `Skip ${pusher.title}` }).tap()
  await page.getByRole('button', { name: `Skip ${checker.title}` }).tap()
  await expect(page).toHaveURL(/#home$/)
})
