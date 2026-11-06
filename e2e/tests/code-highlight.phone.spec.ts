import { CODE, seedCodeBlocks, seedLongCodeBlocks } from './support/code-blocks.js'
import { expect, test, unique } from './support/fixtures.js'
import { longestTask, watchLongTasks } from './support/long-lines.js'
import { expectFitsPhone } from './support/phone-layout.js'

test('code blocks and JSON tool output colour in on a phone and fit it', async ({ page }) => {
  const id = await seedCodeBlocks(unique('Phone code'))
  await page.goto(`/#agents/${id}`)
  const pane = page.getByRole('region', { name: 'Transcript' })
  await expect(pane.getByText(CODE.outro)).toBeVisible()

  const ts = pane.locator('pre > code[data-language="typescript"]')
  await expect(ts.locator('.tok-keyword').first()).toHaveText('const')
  await expectFitsPhone(page, 'a highlighted code block')

  const call = pane.locator('details').filter({ hasText: 'clickup_get_task' })
  await call.locator('summary').tap()
  const output = call.locator('code[data-language="json"]').last()
  await expect(output.locator('.tok-function', { hasText: '"state"' })).toHaveCount(1)
  await expectFitsPhone(page, 'a JSON tool result')
})

test('a block with one huge line stays plain on a phone, and a long block colours', async ({ page }) => {
  await watchLongTasks(page)
  const id = await seedLongCodeBlocks(unique('Phone long code'))
  await page.goto(`/#agents/${id}`)
  const pane = page.getByRole('region', { name: 'Transcript' })
  const [wide, tall] = [pane.locator('pre > code').nth(0), pane.locator('pre > code').nth(1)]
  await expect(tall.locator('.tok-keyword').first()).toHaveText('const')
  await wide.scrollIntoViewIfNeeded()
  await expect(wide).toBeInViewport()
  await expect(wide).not.toHaveAttribute('data-highlighted')
  await expect(wide.locator('span')).toHaveCount(0)
  await expectFitsPhone(page, 'a code block with one huge line')
  expect(await longestTask(page)).toBeLessThan(500)
})
