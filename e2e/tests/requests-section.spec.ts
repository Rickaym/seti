import type { Page } from '@playwright/test'
import { CHECKS_PROMPT, PUSH_PROMPT } from './support/fake-question.js'
import { expect, test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { agentQuestions, askingAgent, requestsDrawer, requestsSection, sectionCount } from './support/questions.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const listHeader = (page: Page) => page.getByRole('heading', { name: 'Agents', level: 1 }).locator('..')

test('Requests sits below Agents in the sidebar with no digit, and stays while none are open', async ({ page }) => {
  await page.goto('/#home')
  const work = page.getByRole('navigation', { name: 'Sections' }).getByRole('group', { name: 'Work' })
  const labels = await work.getByRole('button').evaluateAll((buttons) => buttons.map((b) => b.ariaLabel))
  expect(labels).toEqual(['EA', 'Home', 'Agents', 'Requests'])
  const row = requestsSection(page)
  await expect(row).toBeVisible()
  await expect(sectionCount(row)).toHaveCount(0)
  await expect(row).not.toHaveAttribute('aria-keyshortcuts')

  await page.keyboard.press('Alt+4')
  await expect(page).toHaveURL(/#context$/)
  await page.keyboard.press('Alt+5')
  await expect(page).toHaveURL(/#settings$/)
  await row.click()
  await expect(page).toHaveURL(/#requests$/)
  await expect(row).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('heading', { name: 'Requests' })).toBeVisible()
})

test('the row counts pending requests, the Agents list offers no Requests, and the agent opens its drawer', async ({
  page,
  request,
}) => {
  const pusher = await askingAgent(request, 'Section pusher', PUSH_PROMPT)
  const checker = await askingAgent(request, 'Section checker', CHECKS_PROMPT)
  await page.goto(`/#agents/${checker.id}`)
  const row = requestsSection(page)
  await expect(sectionCount(row)).toHaveText('3')
  await expect(row).toHaveAccessibleDescription('3 requests wait on you')

  const header = listHeader(page)
  await expect(header.getByRole('button')).toHaveCount(4)
  for (const name of ['Grid', 'Filter agents', 'New agent', 'More list actions']) {
    await expect(header.getByRole('button', { name, exact: true })).toBeVisible()
  }
  await header.getByRole('button', { name: 'More list actions' }).click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Archived' })).toBeVisible()
  await expect(menu.getByRole('menuitem')).toHaveCount(1)
  await expect(menu.getByRole('menuitem', { name: 'Import sessions' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()

  await page.getByRole('button', { name: 'Answer 2 requests' }).click()
  const drawer = requestsDrawer(page)
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole('region', { name: /^Questions from / })).toHaveCount(1)
  await expect(page).toHaveURL(new RegExp(`#agents/${checker.id}$`))

  await row.click()
  await expect(page).toHaveURL(/#requests$/)
  await expect(agentQuestions(page, pusher)).toBeVisible()
  await expect(agentQuestions(page, checker)).toBeVisible()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`#agents/${checker.id}$`))

  await row.click()
  await page.getByRole('button', { name: `Skip ${pusher.title}` }).click()
  await page.getByRole('button', { name: `Skip ${checker.title}` }).click()
  await expect(page).toHaveURL(new RegExp(`#agents/${checker.id}$`))
  await expect(sectionCount(row)).toHaveCount(0)
})

test('the old #questions and #agents/questions addresses open Requests and leave no entry', async ({ page }) => {
  await page.goto('/#home')
  await page.evaluate(() => {
    window.location.hash = 'agents/questions'
  })
  await expect(page).toHaveURL(/#requests$/)
  await expect(page.getByRole('heading', { name: 'Requests' })).toBeVisible()
  await expect(requestsSection(page)).toHaveAttribute('aria-current', 'page')
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page).toHaveURL(/#home$/)

  await page.goto('about:blank')
  await page.goto('/#agents/questions')
  await expect(page).toHaveURL(/#requests$/)
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page).toHaveURL(/#agents$/)

  await page.goto('about:blank')
  await page.goto('/#questions')
  await expect(page).toHaveURL(/#requests$/)
  await expect(page.getByRole('heading', { name: 'Requests' })).toBeVisible()
})
