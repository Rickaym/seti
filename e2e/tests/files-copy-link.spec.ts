import type { Page } from '@playwright/test'
import { seedCodeAgent } from './support/code-files.js'
import { expect, test } from './support/fixtures.js'
import { filesPanel, openViewerFile } from './support/viewer-files.js'

const clipboard = async (page: Page) => page.evaluate(async () => navigator.clipboard.readText())

test.use({ allowedHttpStatuses: [409] })

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
})

test('Copy link gives a deep link that opens the file, and a pasted one shows as a card', async ({ page }) => {
  const { id } = await seedCodeAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const panel = filesPanel(page)
  await openViewerFile(page, 'app.ts')

  await panel.getByTestId('viewer-header').getByRole('button', { name: 'Copy link' }).click()
  const origin = new URL(page.url()).origin
  await expect
    .poll(async () => clipboard(page))
    .toMatch(new RegExp(`^${origin}/#agents/${id}/files/[^/]+/docs/app\\.ts$`))
  const link = await clipboard(page)

  await page.goto('/#settings')
  await page.goto(link)
  await expect(page.getByRole('region', { name: 'File docs/app.ts' })).toBeVisible()
  await expect(page.locator('[data-code-file] .tok-keyword').first()).toHaveText('export')
  expect(new URL(page.url()).hash).toBe(`#agents/${id}`)

  await page.route(`**/api/tasks/${id}/messages`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback()
      return
    }
    await route.fulfill({ status: 409, json: { error: { detail: 'The agent cannot take messages now' } } })
  })
  const reply = page.getByRole('combobox', { name: 'Reply' })
  await reply.fill(`Look at\n${link}`)
  await reply.press('Enter')
  const failed = page.locator('[data-pending-send][data-state="failed"]')
  const card = failed.locator('[data-file-card][data-file-link="docs/app.ts"]')
  await expect(card).toBeVisible()
  await expect(card.locator('[data-file-head]')).toHaveText(/^export function greet/)
})

test('a file or folder row copies its link from its menu, and a folder link opens the folder', async ({ page }) => {
  const { id } = await seedCodeAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const panel = filesPanel(page)
  await openViewerFile(page, 'tool.py')
  await panel.getByRole('button', { name: 'Back to the folder' }).click()

  await panel.getByRole('button', { name: /tool\.py/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Copy link' }).click()
  await expect.poll(async () => clipboard(page)).toMatch(/\/files\/[^/]+\/docs\/tool\.py$/)

  await panel.getByRole('combobox', { name: 'Root' }).selectOption({ index: 1 })
  await panel.getByRole('button', { name: /^docs/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Copy link' }).click()
  await expect.poll(async () => clipboard(page)).toMatch(/\/files\/[^/]+\/docs\/$/)
  const folder = await clipboard(page)

  await page.goto('/#settings')
  await page.goto(folder)
  await expect(filesPanel(page).getByRole('navigation', { name: 'Folder' })).toContainText('docs')
  await expect(filesPanel(page).getByRole('button', { name: /huge\.ts/ })).toBeVisible()
})
