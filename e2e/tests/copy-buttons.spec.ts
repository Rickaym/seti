import type { Page } from '@playwright/test'
import { CODE, REPLY, seedCodeBlocks, TURN_REPLY } from './support/code-blocks.js'
import { expect, test, unique } from './support/fixtures.js'

const clipboard = async (page: Page) => page.evaluate(async () => navigator.clipboard.readText())

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
})

test('code blocks, tool output and replies copy their exact text', async ({ page }) => {
  const id = await seedCodeBlocks(unique('Copy'))
  await page.goto(`/#agents/${id}`)
  const pane = page.getByRole('region', { name: 'Transcript' })
  await expect(pane.getByText(CODE.outro)).toBeVisible()

  const block = pane.locator('.group\\/code').filter({ has: page.locator('code[data-language="typescript"]') })
  const copy = block.getByRole('button', { name: 'Copy code' })
  await expect(copy).toHaveCSS('opacity', '0')
  await block.hover()
  await expect(copy).toHaveCSS('opacity', '1')
  await copy.click()
  await expect.poll(async () => clipboard(page)).toBe(CODE.typescript)
  await expect(copy).toHaveAttribute('data-copied', '')
  await expect(copy).not.toHaveAttribute('data-copied', '', { timeout: 3000 })
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)

  const call = pane.locator('details').filter({ hasText: 'clickup_get_task' })
  await call.locator('summary').click()
  const output = call.locator('.group\\/code').last()
  await output.hover()
  await output.getByRole('button', { name: 'Copy code' }).click()
  await expect
    .poll(async () => clipboard(page))
    .toBe('{\n  "state": "OPEN",\n  "checks": [\n    1,\n    2\n  ],\n  "title": "Ship it"\n}')

  const reply = pane.locator('.group\\/reply').filter({ hasText: 'Here is the helper' })
  await reply.getByText('And the manifest').hover()
  await reply.getByRole('button', { name: 'Copy reply' }).click()
  await expect.poll(async () => clipboard(page)).toBe(REPLY)
})

test('the turn-end line copies the turn reply without hover and stays one line tall', async ({ page }) => {
  const id = await seedCodeBlocks(unique('Turn copy'))
  await page.goto(`/#agents/${id}`)
  const pane = page.getByRole('region', { name: 'Transcript' })
  const line = pane.getByText(/^Turn done \u00b7 2 steps/).locator('..')
  const copy = line.getByRole('button', { name: 'Copy reply' })
  await expect(copy).toBeVisible()
  await expect(copy).toHaveCSS('opacity', '1')
  expect((await line.boundingBox())?.height).toBe(16)
  await copy.click()
  await expect.poll(async () => clipboard(page)).toBe(TURN_REPLY)
  await expect(copy).toHaveAttribute('data-copied', '')
})
