import { randomUUID } from 'node:crypto'
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
const main = (page: Page) => page.getByRole('main')
const reply = (page: Page) => main(page).getByRole('combobox', { name: 'Reply' })
const message = (page: Page) => main(page).getByRole('combobox', { name: 'Message', exact: true })

async function pick(page: Page, query: string) {
  await page.keyboard.press('Control+k')
  await expect(palette(page).getByRole('combobox')).toBeFocused()
  await page.keyboard.type(query)
  await page.keyboard.press('Enter')
  await expect(palette(page)).toBeHidden()
}

test('Ctrl+K to an agent focuses its reply box with the caret after the draft', async ({ page }) => {
  const tag = randomUUID().slice(0, 6)
  const id = await seedTask(`Landing agent ${tag}`)
  await page.goto(`/#agents/${id}`)
  await reply(page).click()
  await page.keyboard.type('draft')
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Context' }).click()
  await expect(page).toHaveURL(/#context$/)

  await pick(page, `Landing agent ${tag}`)
  await expect(page).toHaveURL(new RegExp(`#agents/${id}$`))
  await expect(reply(page)).toBeFocused()
  await page.keyboard.type(' more')
  await expect(reply(page)).toHaveValue('draft more')
  await reply(page).fill('')
})

test('Alt chords land in the page they open', async ({ page }) => {
  const tag = randomUUID().slice(0, 6)
  const id = await seedTask(`Landing row ${tag}`)
  await page.goto('/#agents')
  await expect(page.locator(`[data-task-id="${id}"]`)).toBeVisible()
  await expect(message(page)).not.toBeFocused()

  await page.keyboard.press('Alt+2')
  await expect(page).toHaveURL(/#home$/)
  await expect(main(page).getByRole('heading', { name: 'Home', exact: true })).toBeFocused()

  await page.keyboard.press('Alt+4')
  await expect(page).toHaveURL(/#context$/)
  await expect(main(page).getByRole('heading', { name: 'User level / CLAUDE.md' })).toBeFocused()

  await page.keyboard.press('Alt+3')
  await expect(page).toHaveURL(/#agents$/)
  await expect(message(page)).toBeFocused()

  await page.locator(`[data-task-id="${id}"] button`).first().focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`#agents/${id}$`))
  await expect(reply(page)).toBeFocused()
})

test('Alt+N focuses the start page message box, which a plain load leaves alone', async ({ page }) => {
  await page.goto('/#agents')
  await expect(main(page).getByRole('button', { name: 'New agent' })).toHaveAttribute('aria-keyshortcuts', 'Alt+N')
  await expect(message(page)).not.toBeFocused()
  await page.keyboard.press('Alt+n')
  await expect(page).toHaveURL(/#agents\/new$/)
  await expect(message(page)).toBeFocused()
  await page.keyboard.type('typed')
  await expect(message(page)).toHaveValue('typed')
  await message(page).fill('')
})

test('Ctrl+Shift+L focuses the group chat box, even from another field', async ({ page }) => {
  await page.goto('/#agents/new')
  await message(page).click()
  await page.keyboard.press('Control+Shift+L')
  const group = page.getByTestId('team-chat-panel').getByRole('combobox', { name: 'Message the group' })
  await expect(group).toBeFocused()
  await page.keyboard.press('Control+Shift+L')
  await expect(page.getByTestId('team-chat-panel')).toBeHidden()
})

test('Alt+1 focuses the EA chat box without starting a call', async ({ page }) => {
  await page.goto('/#agents')
  await expect(main(page).getByRole('button', { name: 'New agent' })).toHaveAttribute('aria-keyshortcuts', 'Alt+N')
  await page.keyboard.press('Alt+1')
  await expect(page).toHaveURL(/#ea$/)
  await expect(main(page).getByRole('combobox', { name: 'Message the EA' })).toBeFocused()
  await expect(main(page).getByRole('button', { name: 'Call' })).toBeVisible()
})

test('Ctrl+K to a settings page focuses its heading', async ({ page }) => {
  await page.goto('/#agents')
  await pick(page, 'audit settings')
  await expect(page).toHaveURL(/#settings\/audit$/)
  const heading = main(page).getByRole('heading', { name: 'Audit log', exact: true })
  await expect(heading).toBeFocused()
  expect(await heading.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none')
  await page.keyboard.press('Tab')
  await expect(heading).not.toHaveAttribute('tabindex')
})

test('mouse navigation leaves focus where it was', async ({ page }) => {
  const tag = randomUUID().slice(0, 6)
  const id = await seedTask(`Landing mouse ${tag}`)
  await page.goto('/#agents')
  const row = page.locator(`[data-task-id="${id}"] button`).first()
  await row.click()
  await expect(page).toHaveURL(new RegExp(`#agents/${id}$`))
  await expect(reply(page)).toBeVisible()
  await expect(reply(page)).not.toBeFocused()

  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Context' }).click()
  await page.keyboard.press('Control+k')
  await page.keyboard.type(`Landing mouse ${tag}`)
  await palette(page)
    .getByRole('option', { name: new RegExp(`Landing mouse ${tag}`) })
    .click()
  await expect(page).toHaveURL(new RegExp(`#agents/${id}$`))
  await expect(reply(page)).toBeVisible()
  await expect(reply(page)).not.toBeFocused()
})
