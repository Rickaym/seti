import type { Page } from '@playwright/test'
import { CODE, seedCodeBlocks, TURN_REPLY } from './support/code-blocks.js'
import { expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

const clipboard = async (page: Page) => page.evaluate(async () => navigator.clipboard.readText())

test('copy buttons show without hover on a phone, with Copy reply on the turn-end line', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const id = await seedCodeBlocks(unique('Phone copy'))
  await page.goto(`/#agents/${id}`)
  const pane = page.getByRole('region', { name: 'Transcript' })
  await expect(pane.getByText(CODE.outro)).toBeVisible()

  const block = pane.locator('.group\\/code').filter({ has: page.locator('code[data-language="typescript"]') })
  const copy = block.getByRole('button', { name: 'Copy code' })
  await expect(copy).toHaveCSS('opacity', '1')
  expect((await copy.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await copy.tap()
  await expect.poll(async () => clipboard(page)).toBe(CODE.typescript)
  await expect(copy).toHaveAttribute('data-copied', '')

  const replies = pane.locator('.group\\/reply')
  await expect(replies.getByRole('button', { name: 'Copy reply', includeHidden: true })).toHaveCount(3)
  await expect(replies.getByRole('button', { name: 'Copy reply' })).toHaveCount(0)
  const line = pane.getByText(/^Turn done \u00b7 2 steps/).locator('..')
  const reply = line.getByRole('button', { name: 'Copy reply' })
  await expect(reply).toBeVisible()
  expect((await reply.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect((await line.boundingBox())?.height).toBe(16)
  await reply.tap()
  await expect.poll(async () => clipboard(page)).toBe(TURN_REPLY)
  await expect(reply).toHaveAttribute('data-copied', '')
  await expectFitsPhone(page, 'copy buttons in the transcript')
})
