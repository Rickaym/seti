import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'

const guide = (page: Page) => page.getByRole('dialog', { name: 'Shortcuts' })

async function seedTask(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date(Date.now() - 5 * 60_000).toISOString()
  await db.idleTask(id, title, paths.checkout, ts)
  await db.close()
  return id
}

const rows = async (region: Locator) =>
  region
    .locator('dt')
    .evaluateAll((terms) => terms.map((term) => `${term.textContent} ${term.nextElementSibling?.textContent ?? ''}`))

test('the sidebar button opens a guide that lists every chord and no bare letter', async ({ page }) => {
  await page.goto('/#agents')
  const button = page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Shortcuts' })
  await expect(button).toHaveAttribute('aria-keyshortcuts', 'Control+/')
  await button.click()
  await expect(guide(page)).toBeVisible()
  expect(await rows(guide(page).getByRole('region', { name: 'Anywhere' }))).toEqual([
    'Ctrl+K Command palette',
    'Ctrl+/ Shortcuts',
    'Ctrl+F Find in chat or Files',
    'Ctrl+Shift+L Group chat',
    'Ctrl+` Terminal',
    'Ctrl+Shift+E EA call',
    'Alt+1-5 Go to section',
    'Alt+N New agent',
    'Alt+A Switch Claude login',
    'Alt+G Agent grid',
  ])
  expect(await rows(guide(page).getByRole('region', { name: 'Agents' }))).toEqual([
    'Alt+I Import sessions',
    'Alt+/ Filter agents',
    'Alt+U Next unseen agent',
    'Alt+[ ] Step through your messages',
    'Esc Stop agent',
    'Esc Esc Rewind',
    '/btw Ask aside',
    'Alt+Shift+Arrows Move the grid panel',
  ])
  expect(await rows(guide(page).getByRole('region', { name: 'Terminal' }))).toEqual([
    'Shift+Enter New line in Claude Code',
  ])
  await expect(guide(page)).not.toContainText('letter')
  await expect(guide(page).getByRole('button', { name: 'Open command palette' })).toHaveCount(0)
  const statuses = await rows(guide(page).getByRole('region', { name: 'Agent status' }))
  expect(statuses.map((row) => row.split(' ')[0])).toEqual([
    'running',
    'idle',
    'complete',
    'error',
    'interrupted',
    'asks',
    'waits',
    'stopped',
    'unseen',
  ])
  const legend = await rows(guide(page).getByRole('region', { name: 'Status bar' }))
  expect(legend).toContain('need you Agents in the Needs you group')
  expect(legend).toContain('Health Phone: items after the hairline')
  await page.keyboard.press('Escape')
  await expect(guide(page)).toBeHidden()
})

test('Ctrl+/ opens and closes the guide from anywhere, and ? only types', async ({ page }) => {
  await page.goto('/#agents/new')
  const message = page.getByLabel('Message')
  await message.click()
  await page.keyboard.type('why?')
  await expect(message).toHaveValue('why?')
  await expect(guide(page)).toBeHidden()
  await page.keyboard.press('Control+Slash')
  await expect(guide(page)).toBeVisible()
  await page.keyboard.press('Control+Slash')
  await expect(guide(page)).toBeHidden()
  await expect(message).toHaveValue('why?')
  await message.fill('')

  await page.getByRole('heading', { name: 'Agents', exact: true }).click()
  await page.keyboard.press('Shift+Slash')
  await expect(guide(page)).toBeHidden()
  await page.keyboard.press('Control+Slash')
  await expect(guide(page)).toBeVisible()
  await expect(guide(page)).toContainText('Ctrl+K')
  await page.keyboard.press('Control+Slash')
  await expect(guide(page)).toBeHidden()

  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Search Seti' })
  await palette.getByRole('combobox').fill('>keyboard shortcuts')
  await palette.getByRole('option', { name: /Keyboard shortcuts/ }).click()
  await expect(guide(page)).toBeVisible()
})

test('the guide button hint closes with the guide and with the page', async ({ page }) => {
  await page.goto('/#agents')
  const rail = page.getByRole('complementary', { name: 'Sidebar' })
  const button = rail.getByRole('button', { name: 'Shortcuts' })
  const hint = page.getByRole('tooltip', { name: /^Shortcuts/ })

  await button.click()
  await expect(guide(page)).toBeVisible()
  await page.mouse.move(700, 450)
  await page.keyboard.press('Escape')
  await expect(guide(page)).toBeHidden()
  await expect(button).toBeFocused()
  await expect(hint).toHaveCount(0)

  await page.keyboard.press('Control+Slash')
  await expect(guide(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(guide(page)).toBeHidden()
  await expect(hint).toHaveCount(0)

  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await expect(button).toBeFocused()
  await expect(hint).toBeVisible()
  await page.keyboard.press('Alt+4')
  await expect(page).toHaveURL(/#context/)
  await expect(hint).toHaveCount(0)
})

test('list rows show the title and the status on one line, the place and age on hover', async ({ page, request }) => {
  const title = `E2E plain row ${randomUUID().slice(0, 6)}`
  const id = await seedTask(title)
  const db = openSeedDb()
  const pr = `https://github.com/e2e/rows/pull/${String(Date.now() % 100_000)}`
  await db.run(
    `INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES (?, ?, ?, 'user')`,
    id,
    pr,
    new Date().toISOString(),
  )
  await db.close()

  await page.goto(`/#agents/${id}`)
  const row = page.locator(`[data-task-id="${id}"]`)
  await expect(row).toContainText(title)
  await expect(row).not.toContainText(path.basename(paths.checkout))
  const hint = await row.getByRole('button', { name: title }).getAttribute('title')
  expect(hint?.split('\n')).toEqual([paths.checkout, expect.stringMatching(/^\d+m ago$/), 'idle'])
  await expect(row).not.toContainText('#')
  await expect(row).not.toContainText('ago')
  await expect(row.locator('time')).toHaveCount(0)
  const middle = async (part: Locator) => {
    const box = await part.boundingBox()
    return (box?.y ?? 0) + (box?.height ?? 0) / 2
  }
  const titleMiddle = await middle(row.getByText(title, { exact: true }))
  expect(Math.abs((await middle(row.getByRole('img', { name: 'idle' }))) - titleMiddle)).toBeLessThan(2)
  await expect(page.getByRole('main').getByRole('group', { name: /^Pull request rows#/ })).toBeVisible()
  expect((await request.delete(`/api/tasks/${id}`)).ok()).toBe(true)
})
