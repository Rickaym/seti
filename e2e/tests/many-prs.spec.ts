import type { Locator, Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import {
  boxOf,
  linkedCount,
  linkManyPrs,
  LOGIN_PR,
  MANY_PRS,
  mockManyStatuses,
  startAgent,
} from './support/many-prs.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const more = (page: Page) => page.getByRole('main').getByRole('button', { name: /^(\+\d+ more|\d+ PRs)/ })
const chips = (page: Page) => page.getByRole('main').getByRole('group', { name: /^Pull request many#/ })
const threads = (scope: Locator, count: number) =>
  scope.getByRole('img', { name: `${String(count)} unresolved review thread${count === 1 ? '' : 's'}` })
const anyThreads = (scope: Locator) => scope.getByRole('img', { name: /unresolved review thread/ })

/** Where the transcript starts, which moves down whenever the header grows. */
const transcriptTop = async (page: Page) => (await boxOf(page.getByRole('region', { name: 'Transcript' }))).y

test('an agent with 150 linked PRs keeps a one-line header and a working composer', async ({ page, request }) => {
  await mockManyStatuses(page)
  const one = await startAgent(request, 'One PR')
  await linkManyPrs(one.id, 1)
  await page.goto(`/#agents/${one.id}`)
  await expect(chips(page)).toHaveCount(1)
  const baseline = await transcriptTop(page)

  const many = await startAgent(request, 'Many PRs')
  await linkManyPrs(many.id)
  await page.goto(`/#agents/${many.id}`)
  await expect(chips(page).first()).toHaveAccessibleName('Pull request many#150')
  await expect(chips(page).nth(1)).toHaveAccessibleName('Pull request many#149')
  await expect(threads(chips(page).first(), 3)).toBeVisible()
  await expect(anyThreads(chips(page).nth(1))).toHaveCount(0)
  const shown = await chips(page).count()
  expect(shown).toBeLessThanOrEqual(4)
  await expect(more(page)).toHaveText(`+${String(MANY_PRS - shown)} more`)
  expect(await transcriptTop(page)).toBe(baseline)

  const reply = page.getByRole('combobox', { name: 'Reply' })
  await expect(reply).toBeInViewport({ ratio: 1 })
  await reply.click()
  await reply.fill('Still with you')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('region', { name: 'Transcript' })).toContainText('Still with you')
  await expect(reply).toHaveText('')

  await more(page).click()
  const list = page.getByRole('dialog', { name: /^Linked PRs/ })
  await expect(list).toHaveAccessibleName(`Linked PRs (${String(MANY_PRS)})`)
  await expect(list.getByRole('region', { name: 'Needs a fix' })).toContainText('2')
  const scroller = list.getByTestId('linked-pr-list')
  expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  const listBox = await boxOf(list)
  expect(listBox.y + listBox.height).toBeLessThanOrEqual(900)
  await expect(reply).toBeInViewport({ ratio: 1 })
  expect(await transcriptTop(page)).toBe(baseline)

  const filter = list.getByRole('textbox', { name: 'Filter linked PRs' })
  await expect(filter).toBeFocused()
  const badge = threads(list.getByRole('listitem', { name: 'Pull request many#150' }), 3)
  await badge.hover()
  await expect(page.getByRole('tooltip')).toHaveText('3 unresolved review threads')
  await filter.fill('147')
  await expect(threads(list.getByRole('listitem', { name: 'Pull request many#147' }), 1)).toBeVisible()
  await filter.fill('146')
  await expect(list.getByRole('listitem', { name: 'Pull request many#146' })).toBeVisible()
  await expect(anyThreads(list)).toHaveCount(0)
  await filter.fill('login')
  const rows = list.getByRole('listitem')
  await expect(rows).toHaveCount(1)
  const row = list.getByRole('listitem', { name: `Pull request many#${String(LOGIN_PR)}` })
  await expect(row).toContainText('Fix login redirect')
  await filter.fill('#7')
  await expect(rows.first()).toBeVisible()
  expect(await rows.allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining('many#7')]))
  await filter.fill('login')

  await row.getByRole('button', { name: `Unlink many#${String(LOGIN_PR)}` }).click()
  await expect(row).toBeHidden()
  await expect.poll(async () => linkedCount(request, many.id)).toBe(MANY_PRS - 1)
  await expect(list).toBeVisible()
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect.poll(async () => linkedCount(request, many.id)).toBe(MANY_PRS)
  await expect(row).toBeVisible()
  await expect(list).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(list).toBeHidden()
  await expect(reply).toBeInViewport({ ratio: 1 })
})

test('a grid panel keeps the PR row to one line and opens the same list', async ({ page, request }) => {
  await mockManyStatuses(page)
  const many = await startAgent(request, 'Grid many PRs')
  await linkManyPrs(many.id)
  await page.goto(`/#agents/${many.id}`)
  await page.getByRole('button', { name: 'Open in grid' }).click()
  const panel = page.locator('[data-grid-item]').filter({ has: page.getByRole('heading', { name: many.title }) })
  const header = panel.getByTestId('agent-header')
  await expect(header.getByRole('group', { name: 'Pull request many#150' })).toBeVisible()
  const row = header.getByRole('group', { name: /^Pull request many#/ })
  expect(await row.count()).toBeLessThanOrEqual(2)
  const tops = await row.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)))
  expect(new Set(tops).size).toBe(1)
  await expect(panel.getByRole('combobox', { name: 'Reply' })).toBeInViewport({ ratio: 1 })

  await header.getByRole('button', { name: /^(\+\d+ more|\d+ PRs)/ }).click()
  const list = page.getByRole('dialog', { name: /^Linked PRs/ })
  await list.getByRole('textbox', { name: 'Filter linked PRs' }).fill('149')
  await expect(list.getByRole('listitem')).toHaveCount(1)
  await expect(list.getByRole('listitem')).toContainText('conflicts')
  await list.getByRole('textbox', { name: 'Filter linked PRs' }).fill('148')
  await expect(list.locator('.text-muted-foreground', { hasText: 'Many change 148' })).toBeVisible()
})
