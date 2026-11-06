import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'

/** An idle agent written straight into the database, so no turn ever starts. */
async function seedTask(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date().toISOString()
  await db.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, status, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 0, 'idle', ?, ?)`,
    id,
    title,
    paths.checkout,
    ts,
    ts,
  )
  await db.close()
  return id
}

const splitter = (page: Page, name: string) => page.getByRole('separator', { name })

/** The pane a splitter resizes is the element it sits in. */
const paneOf = (handle: Locator) => handle.locator('xpath=..')

async function width(locator: Locator): Promise<number> {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  return Math.round(box?.width ?? 0)
}

/** Drags the splitter's centre `dx` pixels sideways in a few steps, as a hand would. */
async function drag(page: Page, handle: Locator, dx: number): Promise<void> {
  await handle.hover()
  const box = await handle.boundingBox()
  expect(box).not.toBeNull()
  const x = (box?.x ?? 0) + (box?.width ?? 0) / 2
  const y = (box?.y ?? 0) + (box?.height ?? 0) / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx / 2, y, { steps: 4 })
  await page.mouse.move(x + dx, y, { steps: 4 })
  await page.mouse.up()
}

test('the agent list resizes by drag, keeps its width across a reload and resets on double-click', async ({ page }) => {
  await seedTask('Pane resize agent')
  await page.goto('/#agents')
  const handle = splitter(page, 'Resize agent list')
  const list = paneOf(handle)
  await expect(handle).toHaveAttribute('aria-valuenow', '320')
  expect(await width(list)).toBe(320)

  await drag(page, handle, 120)
  await expect.poll(async () => width(list)).toBe(440)
  await expect(handle).toHaveAttribute('aria-valuenow', '440')

  await page.reload()
  await expect.poll(async () => width(paneOf(splitter(page, 'Resize agent list')))).toBe(440)

  await splitter(page, 'Resize agent list').dblclick()
  await expect.poll(async () => width(list)).toBe(320)
  await page.reload()
  await expect.poll(async () => width(paneOf(splitter(page, 'Resize agent list')))).toBe(320)
})

test('a drag stops at the pane limits', async ({ page }) => {
  await page.goto('/#agents')
  const handle = splitter(page, 'Resize agent list')
  const list = paneOf(handle)
  await drag(page, handle, -400)
  await expect.poll(async () => width(list)).toBe(220)
  await drag(page, handle, 900)
  await expect.poll(async () => width(list)).toBe(560)
  await handle.dblclick()
})

test('splitters take arrow keys, Home and End, and the keyed width persists', async ({ page }) => {
  await page.goto('/#settings')
  const handle = splitter(page, 'Resize settings list')
  const list = paneOf(handle)
  await handle.focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(handle).toHaveAttribute('aria-valuenow', String(224 + 32))
  await page.keyboard.press('End')
  await expect.poll(async () => width(list)).toBe(400)
  await page.keyboard.press('Home')
  await expect.poll(async () => width(list)).toBe(180)
  await page.keyboard.press('PageUp')
  await expect.poll(async () => width(list)).toBe(244)

  await page.reload()
  await expect.poll(async () => width(paneOf(splitter(page, 'Resize settings list')))).toBe(244)
  await splitter(page, 'Resize settings list').dblclick()
})

test('the group chat, Files and Processes panels resize from their left edge', async ({ page }) => {
  test.setTimeout(60_000)
  const id = await seedTask('Pane resize panels')
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Group chat', exact: true }).first().click()
  const chat = splitter(page, 'Resize group chat')
  const before = await width(paneOf(chat))
  await drag(page, chat, -80)
  await expect.poll(async () => width(paneOf(chat))).toBe(before + 80)
  await chat.dblclick()
  await expect.poll(async () => width(paneOf(chat))).toBe(before)
  await page.getByRole('button', { name: 'Group chat', exact: true }).first().click()

  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const files = splitter(page, 'Resize files')
  const filesBefore = await width(paneOf(files))
  await files.focus()
  await page.keyboard.press('ArrowLeft')
  await expect.poll(async () => width(paneOf(files))).toBe(filesBefore + 16)
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => width(paneOf(files))).toBe(filesBefore)

  await page.getByRole('button', { name: 'Processes', exact: true }).click()
  const processes = splitter(page, 'Resize processes')
  await expect(processes).toBeVisible()
  const sheet = paneOf(processes)
  await expect.poll(async () => width(sheet)).toBe(576)
  await drag(page, processes, -100)
  await expect.poll(async () => width(sheet)).toBe(676)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Processes', exact: true }).click()
  await expect.poll(async () => width(paneOf(splitter(page, 'Resize processes')))).toBe(676)
  await splitter(page, 'Resize processes').dblclick()
  await expect.poll(async () => width(paneOf(splitter(page, 'Resize processes')))).toBe(576)
})
