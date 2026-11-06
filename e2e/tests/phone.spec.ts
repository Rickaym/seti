import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import type { EaHealth } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { botClosed, fakeEa } from './support/fake-ea.js'
import { expect, test } from './support/fixtures.js'
import { HUNG_TASK, mockResources } from './support/resources.js'

test.use({ permissions: ['microphone'] })

const READY: EaHealth = { ok: true, configured: true, missing: [], model: 'gpt-4.1-mini', turn: true }
const SECTIONS = [
  'ea',
  'agents',
  'context',
  'settings',
  'settings/general',
  'settings/repos',
  'settings/ea',
  'settings/resources',
  'settings/account',
  'settings/mcp',
  'settings/plugins',
  'settings/skills',
  'settings/subagents',
  'settings/signin',
  'settings/sandbox',
  'settings/audit',
] as const

const assistant = (content: unknown[]) => ({
  type: 'assistant',
  message: { id: randomUUID(), type: 'message', role: 'assistant', model: 'claude', content },
  parent_tool_use_id: null,
  session_id: 'phone-session',
  uuid: randomUUID(),
})

const LONG_CODE = `Here is the change:\n\n\`\`\`ts\nexport const line = '${'x'.repeat(240)}'\n\`\`\``

/** An idle task with `steps` assistant messages, written straight into the database. */
async function seedTask(title: string, steps: number): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date().toISOString()
  await db.idleTask(id, title, paths.checkout, ts)
  await db.message(id, 'prompt', JSON.stringify({ text: `Start ${title}.` }), ts)
  for (let step = 0; step < steps; step++) {
    const text = step === steps - 1 ? LONG_CODE : `Phone step ${String(step)} of ${title}.`
    await db.message(id, 'sdk', JSON.stringify(assistant([{ type: 'text', text }])), ts)
  }
  await db.close()
  return id
}

async function mockEa(page: Page): Promise<void> {
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: READY }))
  await page.route('**/api/ea/ice', async (route) => route.fulfill({ json: { iceServers: [] } }))
  await fakeEa(page)
}

const horizontalOverflow = async (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

const drawer = (page: Page) => page.getByRole('dialog', { name: 'SETI' })
const eaItem = (page: Page) => page.getByRole('contentinfo').getByRole('group', { name: 'EA', exact: true })
const eaSheet = (page: Page) => page.getByRole('region', { name: 'EA call' })

async function openSection(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: 'Menu' }).tap()
  await drawer(page).getByRole('button', { name: label, exact: true }).tap()
  await expect(drawer(page)).toBeHidden()
}

async function inViewport(page: Page, locator: Locator): Promise<boolean> {
  const box = await locator.boundingBox()
  const height = page.viewportSize()?.height ?? 0
  return box !== null && box.y >= 0 && box.y + box.height <= height
}

test('the sidebar is a drawer that closes on a section change', async ({ page }) => {
  await page.goto('/#agents')
  await expect(page.getByRole('complementary')).toBeHidden()
  await page.getByRole('button', { name: 'Menu' }).tap()
  await expect(drawer(page)).toBeVisible()
  await expect(drawer(page).getByRole('button', { name: 'Agents', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await drawer(page).getByRole('button', { name: 'Close' }).tap()
  await expect(drawer(page)).toBeHidden()

  await page.getByRole('button', { name: 'Menu' }).tap()
  await expect(drawer(page).getByRole('navigation', { name: 'Sections' }).getByRole('button')).toHaveText([
    'EA',
    'Home',
    'Agents',
    'Context',
    'Settings',
  ])
  await drawer(page).getByRole('button', { name: 'Close' }).tap()
  await openSection(page, 'Context')
  await expect(page).toHaveURL(/#context$/)
  await openSection(page, 'EA')
  await expect(page).toHaveURL(/#ea$/)
  await expect(page.getByRole('main').getByRole('heading', { name: 'EA', level: 1 })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Message the EA' })).toBeVisible()
})

test('tasks show the list or the detail, and back returns to the list', async ({ page }) => {
  const title = `Phone detail ${randomUUID().slice(0, 8)}`
  const id = await seedTask(title, 3)
  await page.goto('/#agents')
  const main = page.getByRole('main')
  const listed = main.getByRole('button', { name: new RegExp(title) })
  expect((await listed.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await expect(listed.locator('time'), 'rows show no age').toHaveCount(0)
  await listed.tap()
  await expect(page).toHaveURL(new RegExp(`#agents/${id}$`))
  await expect(main.getByRole('heading', { name: title, level: 2 })).toBeVisible()
  await expect(listed).toBeHidden()

  await main.getByRole('button', { name: 'Back to agents' }).tap()
  await expect(page).toHaveURL(/#agents$/)
  await expect(listed).toBeVisible()
  await expect(main.getByRole('heading', { name: title, level: 2 })).toBeHidden()

  await listed.tap()
  await expect(page).toHaveURL(new RegExp(`#agents/${id}$`))
  await page.goBack()
  await expect(page).toHaveURL(/#agents$/)
  await expect(listed).toBeVisible()
})

test('the agents page lands on the list and New agent opens the start page', async ({ page }) => {
  await page.goto('/#agents')
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
  await expect(main.getByRole('heading', { name: /^Your move/ })).toBeHidden()
  await expect(page.getByLabel('Message')).toBeHidden()

  await main.getByRole('button', { name: 'New agent' }).tap()
  await expect(page).toHaveURL(/#agents\/new$/)
  await expect(main.getByRole('heading', { name: /^Your move/ })).toBeVisible()
  await expect(main.getByRole('heading', { name: 'Agents', level: 1 })).toBeHidden()
  await main.getByRole('button', { name: 'Back to agents' }).tap()
  await expect(page).toHaveURL(/#agents$/)
  await expect(main.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
  await expect(main.getByRole('heading', { name: /^Your move/ })).toBeHidden()
})

test('a long transcript scrolls by touch and code scrolls inside its block', async ({ page }) => {
  const title = `Phone scroll ${randomUUID().slice(0, 8)}`
  const id = await seedTask(title, 150)
  await page.goto(`/#agents/${id}`)
  const transcript = page.getByRole('region', { name: 'Transcript' })
  await expect(transcript.getByText('Here is the change:')).toBeVisible()
  const code = transcript.locator('pre').last()
  expect(await code.evaluate((pre) => pre.scrollWidth > pre.clientWidth)).toBe(true)
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)

  const top = async () => transcript.evaluate((el) => el.scrollTop)
  const before = await top()
  expect(before).toBeGreaterThan(0)
  const box = await transcript.boundingBox()
  const x = Math.round((box?.x ?? 0) + (box?.width ?? 0) / 2)
  const y = Math.round((box?.y ?? 0) + 40)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  for (let step = 1; step <= 10; step++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + step * 30 }] })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await expect.poll(top).toBeLessThan(before)
})

test('the composer stays visible when the keyboard shrinks the viewport', async ({ page }) => {
  const id = await seedTask(`Phone composer ${randomUUID().slice(0, 8)}`, 20)
  await page.goto(`/#agents/${id}`)
  const reply = page.getByLabel('Reply', { exact: true })
  const send = page.getByRole('button', { name: 'Send' })
  await reply.tap()
  await expect(reply).toBeFocused()
  expect(await reply.evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px')
  expect(await reply.getAttribute('placeholder')).not.toContain('Ctrl')

  const size = page.viewportSize() ?? { width: 390, height: 844 }
  await page.setViewportSize({ width: size.width, height: 420 })
  await reply.fill('Checked from a phone')
  await expect.poll(async () => inViewport(page, reply)).toBe(true)
  await expect.poll(async () => inViewport(page, send)).toBe(true)
  const sendBox = await send.boundingBox()
  expect(sendBox?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
})

test('a tap on EA opens a sheet whose call lasts across sections and the drawer', async ({ page }) => {
  await mockEa(page)
  await page.goto('/#agents')
  const open = eaItem(page).getByRole('button', { name: 'EA', exact: true })
  await open.tap()
  await expect(eaSheet(page)).toBeVisible()
  await expect(eaSheet(page)).not.toContainText('Ctrl+Shift+E')
  const call = eaSheet(page).getByRole('button', { name: 'Call', exact: true })
  expect((await call.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await call.tap()
  await expect(eaSheet(page).getByTestId('ea-status')).toHaveText('Listening')
  for (const name of ['Mute', 'Sleep', 'Hang up']) {
    const button = eaSheet(page).getByRole('button', { name, exact: true })
    expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  }
  await eaSheet(page).getByRole('button', { name: 'Close' }).tap()
  await expect(eaSheet(page)).toBeHidden()

  const status = eaItem(page).getByTestId('ea-bar-status')
  await expect(status).toHaveText('Listening')
  await openSection(page, 'Settings')
  await page.getByRole('button', { name: 'Menu' }).tap()
  await expect(page.getByTestId('ea-bar-status')).toHaveText('Listening')
  await drawer(page).getByRole('button', { name: 'Close' }).tap()
  await openSection(page, 'Context')
  await expect(status).toHaveText('Listening')
  expect(await botClosed(page)).toBe(false)
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)

  await eaItem(page).getByRole('button', { name: 'EA call controls' }).tap()
  const mute = eaSheet(page).getByRole('button', { name: 'Mute', exact: true })
  await mute.tap()
  await expect(mute).toHaveAttribute('aria-pressed', 'true')
  await eaSheet(page).getByRole('button', { name: 'Hang up', exact: true }).tap()
  await expect(eaSheet(page).getByRole('button', { name: 'Call', exact: true })).toBeVisible()
  await expect.poll(async () => botClosed(page)).toBe(true)
})

test('no section scrolls the page sideways', async ({ page }) => {
  await seedTask(`Phone overflow ${randomUUID().slice(0, 8)}`, 5)
  for (const section of SECTIONS) {
    await page.goto(`/#${section}`)
    await expect(page.getByRole('main').getByRole('heading').first()).toBeVisible()
    expect(await horizontalOverflow(page), section).toBeLessThanOrEqual(0)
  }
})

test('settings is a list whose pages open full screen with a back button', async ({ page }) => {
  await page.goto('/#agents')
  await openSection(page, 'Settings')
  await expect(page).toHaveURL(/#settings$/)
  const main = page.getByRole('main')
  const list = main.getByRole('navigation', { name: 'Settings pages' })
  await expect(main.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
  await expect(list.locator('[aria-current="page"]')).toHaveCount(0)
  const general = list.getByRole('button', { name: 'General' })
  expect((await general.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)

  await general.tap()
  await expect(page).toHaveURL(/#settings\/general$/)
  await expect(main.getByRole('heading', { name: 'General', level: 2 })).toBeVisible()
  await expect(list).toBeHidden()
  await main.getByRole('button', { name: 'Back to settings' }).tap()
  await expect(page).toHaveURL(/#settings$/)
  await expect(list).toBeVisible()

  await list.getByRole('button', { name: 'Sandbox' }).tap()
  await expect(main.getByRole('heading', { name: 'Sandbox', level: 2 })).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(/#settings$/)
  await expect(list).toBeVisible()

  await page
    .getByRole('contentinfo')
    .getByRole('button', { name: /^Health: / })
    .tap()
  await page
    .getByRole('dialog', { name: 'Health' })
    .getByRole('button', { name: /^Sandbox (on|off)$/ })
    .tap()
  await expect(page.getByRole('dialog', { name: 'Health' })).toBeHidden()
  await expect(page).toHaveURL(/#settings\/sandbox$/)
  await expect(main.getByRole('switch', { name: 'Sandbox agents' })).toBeVisible()
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
})

test('resources lists tasks as cards, and the status bar folds the warning into Health', async ({ page }) => {
  const stopped = await mockResources(page)
  await page.goto('/#agents')
  const bar = page.getByRole('contentinfo')
  await expect(bar.getByRole('button', { name: 'Resources' })).toHaveCount(0)
  const health = bar.getByRole('button', { name: /^Health: \d+ to check$/ })
  await expect(health).toHaveAttribute('data-tone', /warning|critical/)
  await health.tap()
  const item = page.getByRole('dialog', { name: 'Health' }).getByRole('button', { name: 'Resources' })
  await expect(item.getByTestId('resource-anomalies')).toHaveText('5')
  await expect(item).toContainText('73%')
  await item.tap()
  await expect(page).toHaveURL(/#settings\/resources$/)
  const main = page.getByRole('main')
  const tasks = main.getByRole('region', { name: 'Agents' })
  await expect(tasks.getByRole('table')).toHaveCount(0)
  const hung = tasks.getByRole('listitem', { name: HUNG_TASK.title })
  await expect(hung).toContainText('Hung tool call')
  await expect(hung).toContainText('--short')
  await hung.getByRole('button', { name: `Stop ${HUNG_TASK.title}` }).tap()
  await expect.poll(() => stopped).toEqual([`/api/tasks/${HUNG_TASK.id}/stop`])
  const components = main.getByRole('region', { name: 'Seti components' })
  await expect(components.getByRole('listitem', { name: 'Redis' })).toContainText('used_memory 4 MB')
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
})
