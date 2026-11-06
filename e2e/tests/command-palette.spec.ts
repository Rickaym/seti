import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'

async function seedTask(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date().toISOString()
  await db.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, sandbox, status, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 0, 1, 'idle', ?, ?)`,
    id,
    title,
    paths.checkout,
    ts,
    ts,
  )
  await db.close()
  return id
}

const palette = (page: Page) => page.getByRole('dialog', { name: 'Search Seti' })
const paletteInput = (page: Page) => palette(page).getByRole('combobox')

async function openPalette(page: Page) {
  await page.keyboard.press('Control+k')
  await expect(paletteInput(page)).toBeFocused()
}

test('Ctrl+K goes to an agent by a fuzzy name and lists it as recent next time', async ({ page }) => {
  const tag = randomUUID().slice(0, 6)
  const id = await seedTask(`Palette target ${tag}`)
  await page.goto('/#agents')
  await expect(page.locator(`[data-task-id="${id}"]`)).toBeVisible()

  await openPalette(page)
  await paletteInput(page).fill(`pltrg ${tag}`)
  const option = palette(page).getByRole('option', { name: new RegExp(`Palette target ${tag}`) })
  await expect(option).toHaveAttribute('aria-selected', 'true')
  await expect(option.locator('mark').first()).toHaveText('P')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`#agents/${id}$`))
  await expect(palette(page)).toBeHidden()

  await openPalette(page)
  const recent = palette(page).getByRole('group', { name: 'Recent' })
  await expect(recent.getByRole('option').first()).toContainText(`Palette target ${tag}`)
  await page.keyboard.press('Escape')
  await expect(palette(page)).toBeHidden()
})

test('agent rows name their folder and keep the full path for hover', async ({ page }) => {
  const tag = randomUUID().slice(0, 6)
  const id = await seedTask(`Palette folder ${tag}`)
  await page.goto('/#agents')
  await expect(page.locator(`[data-task-id="${id}"]`)).toBeVisible()

  await openPalette(page)
  await paletteInput(page).fill(`Palette folder ${tag}`)
  const option = palette(page).getByRole('option', { name: new RegExp(`Palette folder ${tag}`) })
  await expect(option).toContainText(path.basename(paths.checkout))
  await expect(option).not.toContainText(paths.checkout)
  await expect(option.getByTitle(paths.checkout, { exact: true })).toHaveText(
    new RegExp(`^${path.basename(paths.checkout)}, \\d+[smhd] ago$`),
  )
  await page.keyboard.press('Escape')
  expect((await page.request.delete(`/api/tasks/${id}`)).ok()).toBe(true)
})

test('goes to a settings page with the keyboard alone', async ({ page }) => {
  await page.goto('/#agents')
  await openPalette(page)
  await page.keyboard.type('audit settings')
  await expect(palette(page).getByRole('option', { name: /Audit log/ })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#settings\/audit$/)

  await openPalette(page)
  await page.keyboard.type('ssh hosts')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowUp')
  await expect(palette(page).getByRole('option', { name: /^SSH\b/ })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#settings\/ssh$/)
})

test('> switches to commands that toggle the theme and start a new agent', async ({ page }) => {
  await page.goto('/#agents')
  const html = page.locator('html')
  await expect(html).not.toHaveClass(/\bdark\b/)

  await openPalette(page)
  await palette(page)
    .getByRole('option', { name: /Show commands/ })
    .click()
  await expect(paletteInput(page)).toHaveValue('>')
  await expect(palette(page).getByRole('option', { name: /Open group chat/ })).toContainText('Ctrl+Shift+L')
  await page.keyboard.type('theme')
  await page.keyboard.press('Enter')
  await expect(html).toHaveClass(/\bdark\b/)

  await openPalette(page)
  await page.keyboard.type('>new agent')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#agents\/new$/)
})

test('Ctrl+K opens from inside a field and Escape gives focus back', async ({ page }) => {
  await page.goto('/#agents/new')
  const message = page.getByLabel('Message')
  await message.click()
  await message.pressSequentially('draft')
  await openPalette(page)
  await page.keyboard.press('Escape')
  await expect(palette(page)).toBeHidden()
  await expect(message).toBeFocused()
  await expect(message).toHaveValue('draft')
  await message.fill('')
})

test('only the shortcut opens it on desktop, and app chords wait while it is open', async ({ page }) => {
  await page.goto('/#agents')
  await expect(page.getByRole('banner').getByRole('button', { name: 'Search' })).toHaveCount(0)
  await openPalette(page)
  await page.keyboard.type('n')
  await page.keyboard.press('Alt+n')
  await expect(paletteInput(page)).toHaveValue('n')
  await expect(page).toHaveURL(/#agents$/)
  await page.keyboard.press('Control+k')
  await expect(palette(page)).toBeHidden()

  await page.getByRole('heading', { name: 'Agents', exact: true }).click()
  await page.keyboard.press('Alt+n')
  await expect(page).toHaveURL(/#agents\/new$/)
})

test('lists the sections with their Alt chords and New agent with Alt+N', async ({ page }) => {
  await page.goto('/#agents')
  await openPalette(page)
  const sections = palette(page).getByRole('group', { name: 'Sections' })
  await expect(sections.getByRole('option', { name: /^EA/ })).toContainText('Alt+1')
  await expect(sections.getByRole('option', { name: /^Settings/ })).toContainText('Alt+5')
  await expect(sections.getByRole('option', { name: /^Group chat/ })).toContainText('Ctrl+Shift+L')
  await paletteInput(page).fill('>new agent')
  await expect(palette(page).getByRole('option', { name: /^New agent/ })).toContainText('Alt+N')
  await paletteInput(page).fill('>keyboard shortcuts')
  await expect(palette(page).getByRole('option', { name: /^Keyboard shortcuts/ })).toContainText('Ctrl+/')
})

test('offers the open agent its own commands', async ({ page }) => {
  const tag = randomUUID().slice(0, 6)
  const id = await seedTask(`Palette commands ${tag}`)
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: `Palette commands ${tag}` })).toBeVisible()

  await openPalette(page)
  await page.keyboard.type('>')
  await expect(palette(page).getByRole('group', { name: 'Current agent' })).toBeVisible()
  await expect(palette(page).getByRole('option', { name: /Stop agent/ })).toHaveCount(0)
  await page.keyboard.type('rename')
  await page.keyboard.press('Enter')
  const name = main.getByLabel('Agent name')
  await expect(name).toBeFocused()
  await expect(name).toHaveValue(`Palette commands ${tag}`)
  await name.press('Escape')

  await openPalette(page)
  await page.keyboard.type('>access')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: `Access of Palette commands ${tag}` })).toBeVisible()

  await page.goto('/#context')
  await openPalette(page)
  await page.keyboard.type('>rename')
  await expect(palette(page).getByText('No matching command.')).toBeVisible()
})
