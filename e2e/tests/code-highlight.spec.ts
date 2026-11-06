import type { Locator, Page } from '@playwright/test'
import { CODE, LONG_BLOCKS, seedCodeBlocks, seedLongCodeBlocks } from './support/code-blocks.js'
import { expect, test, unique } from './support/fixtures.js'
import { longestTask, watchLongTasks } from './support/long-lines.js'

const transcript = (page: Page) => page.getByRole('region', { name: 'Transcript' })

const colourOf = async (locator: Locator) => locator.evaluate((el) => getComputedStyle(el).color)

test('colours fenced code by its tag, guesses JSON, and keeps the text as written', async ({ page }) => {
  const id = await seedCodeBlocks(unique('Code'))
  await page.goto(`/#agents/${id}`)
  const pane = transcript(page)
  await expect(pane.getByText(CODE.outro)).toBeVisible()

  const ts = pane.locator('pre > code[data-language="typescript"]')
  await expect(ts).toHaveAttribute('data-highlighted', '')
  await expect(ts.locator('.tok-keyword').first()).toHaveText('const')
  await expect(ts.locator('.tok-string')).toHaveText("'why'")
  await expect(ts.locator('.tok-literal')).toHaveText('42')
  expect(await ts.textContent()).toBe(`${CODE.typescript}\n`)
  expect(await colourOf(ts.locator('.tok-keyword').first())).not.toBe(await colourOf(ts))

  const guessed = pane.locator('pre > code[data-language="json"]')
  await expect(guessed.locator('.tok-function').first()).toHaveText('"name"')
  await expect(guessed.locator('.tok-literal')).toHaveText('true')
})

test('a JSON tool result shows indented and coloured', async ({ page }) => {
  const id = await seedCodeBlocks(unique('Code tool'))
  await page.goto(`/#agents/${id}`)
  const pane = transcript(page)
  await expect(pane.getByText(CODE.outro)).toBeVisible()

  const call = pane.locator('details').filter({ hasText: 'clickup_get_task' })
  await call.locator('summary').click()
  const output = call.locator('code[data-language="json"]').last()
  await expect(output).toHaveAttribute('data-highlighted', '')
  await expect(output).toContainText('"state": "OPEN",\n  "checks": [\n    1,')
  await expect(output.locator('.tok-function', { hasText: '"title"' })).toHaveCount(1)
  await expect(output.locator('.tok-string', { hasText: '"Ship it"' })).toHaveCount(1)
  const input = call.locator('code[data-language="json"]').first()
  await expect(input.locator('.tok-string')).toHaveText('"42"')
})

test('a block with one huge line stays plain, and a long block colours without stalling', async ({ page }) => {
  await watchLongTasks(page)
  const id = await seedLongCodeBlocks(unique('Long code'))
  await page.goto(`/#agents/${id}`)
  const pane = transcript(page)
  const [wide, tall] = [pane.locator('pre > code').nth(0), pane.locator('pre > code').nth(1)]
  await expect(tall).toHaveAttribute('data-highlighted', '')
  await expect(tall.locator('.tok-keyword').first()).toHaveText('const')
  await wide.scrollIntoViewIfNeeded()
  await expect(wide).toBeInViewport()
  await expect(tall).toHaveAttribute('data-highlighted', '')
  expect(await wide.textContent()).toBe(`${LONG_BLOCKS.wide}\n`)
  await expect(wide).not.toHaveAttribute('data-highlighted')
  await expect(wide.locator('span')).toHaveCount(0)
  expect(await longestTask(page)).toBeLessThan(500)
})
