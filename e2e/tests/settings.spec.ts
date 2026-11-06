import type { Page } from '@playwright/test'
import type { EaSettings } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'

const PAGES = [
  { label: 'General', hash: 'general', group: 'App' },
  { label: 'Notifications', hash: 'notifications', group: 'App' },
  { label: 'EA', hash: 'ea', group: 'App' },
  { label: 'About', hash: 'about', group: 'App' },
  { label: 'Lifecycle', hash: 'agents', group: 'Agents' },
  { label: 'Repos', hash: 'repos', group: 'Agents' },
  { label: 'Resources', hash: 'resources', group: 'Agents' },
  { label: 'Channels', hash: 'channels', group: 'Agents' },
  { label: 'Account', hash: 'account', group: 'Claude Code' },
  { label: 'MCP servers', hash: 'mcp', group: 'Claude Code' },
  { label: 'Plugins', hash: 'plugins', group: 'Claude Code' },
  { label: 'Skills', hash: 'skills', group: 'Claude Code' },
  { label: 'Subagents', hash: 'subagents', group: 'Claude Code' },
  { label: 'Sign-in', hash: 'signin', group: 'Security' },
  { label: 'Sandbox', hash: 'sandbox', group: 'Security' },
  { label: 'Permissions', hash: 'permissions', group: 'Security' },
  { label: 'Credentials', hash: 'credentials', group: 'Security' },
  { label: 'SSH', hash: 'ssh', group: 'Security' },
  { label: 'Sharing', hash: 'sharing', group: 'Security' },
  { label: 'Audit log', hash: 'audit', group: 'Security' },
] as const

/** Links to parts of the pages that held several concerns before each got its own page. */
const OLD_LINKS = [
  { from: 'general/preferences', to: 'general', title: 'General' },
  { from: 'general/notifications', to: 'notifications', title: 'Notifications' },
  { from: 'general/repos', to: 'repos', title: 'Repos' },
  { from: 'general/about', to: 'about', title: 'About' },
  { from: 'plugins/skills', to: 'skills', title: 'Skills' },
  { from: 'plugins/subagents', to: 'subagents', title: 'Subagents' },
  { from: 'signin/browsers', to: 'signin', title: 'Sign-in' },
  { from: 'signin/devices', to: 'signin', title: 'Sign-in' },
  { from: 'credentials/sets', to: 'credentials', title: 'Credentials' },
  { from: 'credentials/sets/default', to: 'credentials/default', title: 'Default' },
  { from: 'credentials/secrets', to: 'credentials', title: 'Credentials' },
  { from: 'credentials/hosts', to: 'ssh', title: 'SSH' },
  { from: 'credentials/keys', to: 'ssh', title: 'SSH' },
  { from: 'ssh-hosts', to: 'ssh', title: 'SSH' },
  { from: 'ssh-keys', to: 'ssh', title: 'SSH' },
] as const

/** Pages merged into a neighbour: the old key, the page that holds it now and the card it meant. */
const MERGED = [
  { from: 'whats-new', to: 'about', title: 'About', card: 'changes' },
  { from: 'devices', to: 'signin', title: 'Sign-in', card: 'phones' },
  { from: 'secrets', to: 'credentials', title: 'Credentials', card: 'secrets' },
] as const

const nav = (page: Page) => page.getByRole('navigation', { name: 'Settings pages' })
const pageTitle = (page: Page, name: string) =>
  page.getByRole('main').getByRole('heading', { name, level: 2, exact: true })

test('the settings list opens every page in its group', async ({ page }) => {
  await page.goto('/#settings')
  await expect(page.getByRole('main').getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
  await expect(nav(page).getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'page')
  await expect(pageTitle(page, 'General')).toBeVisible()
  for (const entry of PAGES) {
    const button = nav(page).getByRole('group', { name: entry.group }).getByRole('button', { name: entry.label })
    await button.click()
    await expect(page).toHaveURL(new RegExp(`#settings/${entry.hash}$`))
    await expect(button).toHaveAttribute('aria-current', 'page')
    await expect(pageTitle(page, entry.label)).toBeVisible()
  }
  await expect(nav(page).locator('[aria-current="page"]')).toHaveCount(1)
})

test('deep links open settings pages and keep the audit area', async ({ page }) => {
  for (const entry of PAGES) {
    await page.goto(`/#settings/${entry.hash}`)
    await expect(pageTitle(page, entry.label)).toBeVisible()
  }
  await page.goto('/#settings/audit/repo')
  await expect(page.getByRole('main').getByRole('combobox', { name: 'Area' })).toHaveText('Repos')
})

test('old links to parts of merged pages land on the page that holds them now', async ({ page }) => {
  for (const entry of OLD_LINKS) {
    await page.goto(`/#settings/${entry.from}`)
    await expect(page).toHaveURL(new RegExp(`#settings/${entry.to}$`))
    await expect(pageTitle(page, entry.title)).toBeVisible()
  }
  await page.goto('/#agents')
  await page.evaluate(() => {
    window.location.hash = 'settings/credentials/hosts'
  })
  await expect(page).toHaveURL(/#settings\/ssh$/)
  await page.goBack()
  await expect(page).toHaveURL(/#agents$/)
})

test('old keys of merged pages open the page that holds them, scrolled to their card', async ({ page }) => {
  for (const entry of MERGED) {
    await page.goto(`/#settings/${entry.from}`)
    await expect(page).toHaveURL(new RegExp(`#settings/${entry.to}$`))
    await expect(pageTitle(page, entry.title)).toBeVisible()
    await expect(page.locator(`#${entry.card}`)).toBeInViewport()
    await expect(nav(page).getByRole('button', { name: entry.title })).toHaveAttribute('aria-current', 'page')
  }
})

test('old section hashes land on their settings pages without a history entry', async ({ page }) => {
  const moved = [
    { from: '#capabilities', to: /#settings\/mcp$/, title: 'MCP servers' },
    { from: '#repos', to: /#settings\/repos$/, title: 'Repos' },
    { from: '#audit', to: /#settings\/audit$/, title: 'Audit log' },
    { from: '#audit/pr', to: /#settings\/audit\/pr$/, title: 'Audit log' },
  ]
  for (const entry of moved) {
    await page.goto(`/${entry.from}`)
    await expect(page).toHaveURL(entry.to)
    await expect(pageTitle(page, entry.title)).toBeVisible()
  }
  await expect(page.getByRole('main').getByRole('combobox', { name: 'Area' })).toHaveText('Pull requests')

  await page.goto('/#agents')
  await page.evaluate(() => {
    window.location.hash = 'repos'
  })
  await expect(page).toHaveURL(/#settings\/repos$/)
  await page.goBack()
  await expect(page).toHaveURL(/#agents$/)
})

test('status bar items open their settings pages', async ({ page }) => {
  await page.goto('/#agents')
  const bar = page.getByRole('contentinfo')
  await bar.getByRole('button', { name: 'Sandbox on' }).click()
  await expect(page).toHaveURL(/#settings\/sandbox$/)
  await expect(pageTitle(page, 'Sandbox')).toBeVisible()
  await bar.getByRole('button', { name: 'Claude account' }).click()
  await expect(page).toHaveURL(/#settings\/account$/)
  await expect(pageTitle(page, 'Account')).toBeVisible()
  await expect(page.getByRole('main').getByRole('button', { name: 'Recheck' })).toBeVisible()
})

test('general switches between light, dark and the system mode', async ({ page }) => {
  await page.goto('/#settings/general')
  const html = page.locator('html')
  const mode = page.getByRole('main').getByRole('group', { name: 'Color mode' })
  await expect(html).toHaveClass(/\blight\b/)
  await mode.getByRole('button', { name: 'Dark' }).click()
  await expect(html).toHaveClass(/\bdark\b/)
  await expect(mode.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true')
  await page.reload()
  await expect(html).toHaveClass(/\bdark\b/)
  await mode.getByRole('button', { name: 'System' }).click()
  await expect(html).toHaveClass(/\blight\b/)
  await expect(mode.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'true')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(html).toHaveClass(/\bdark\b/)
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(html).toHaveClass(/\blight\b/)
  await mode.getByRole('button', { name: 'Light' }).click()
  await expect(mode.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true')
})

test.describe('the EA page', () => {
  const WAKE_OFF = { wake_enabled: false, wake_phrase: 'Hey Seti', keep_awake_seconds: 30 }

  test.afterEach(async ({ request }) => {
    await request.put('/api/ea/settings', { data: WAKE_OFF })
  })

  test('sets the wake word and shows the setup the EA needs', async ({ page, request }) => {
    expect((await request.put('/api/ea/settings', { data: WAKE_OFF })).ok()).toBe(true)
    await page.goto('/#settings/ea')
    const main = page.getByRole('main')
    await expect(main.getByRole('region', { name: 'EA setup' })).toContainText('The EA is not running')
    const wake = main.getByRole('group', { name: 'Wake word' })
    await wake.getByLabel('Wake phrase').fill('Hello Seti')
    await wake.getByLabel('Wake phrase').press('Enter')
    await wake.getByRole('button', { name: 'Wake word' }).click()
    await expect(wake.getByRole('button', { name: 'Wake word' })).toHaveAttribute('aria-pressed', 'true')
    await expect
      .poll(async () => apiData<EaSettings>(request, '/ea/settings'))
      .toMatchObject({ wake_enabled: true, wake_phrase: 'Hello Seti' })
  })

  test('holds what the call popover no longer shows', async ({ page }) => {
    await page.goto('/#settings/ea')
    const main = page.getByRole('main')
    const audio = main.getByRole('region', { name: 'Audio' })
    await expect(audio.getByRole('button', { name: 'Mute EA' })).toHaveAttribute('aria-pressed', 'false')
    const connection = main.getByRole('region', { name: 'Connection' })
    for (const label of ['Voice model', 'Call relay', 'Reply time', 'Relay test']) {
      await expect(connection.getByText(label, { exact: true })).toBeVisible()
    }
    await expect(connection.getByRole('button', { name: 'Test relay' })).toBeEnabled()
  })
})

test('settings pages take no letter keys and the section chords still leave them', async ({ page }) => {
  await page.goto('/#settings/general')
  const keys = await page.evaluate(() =>
    [...document.querySelectorAll('[aria-keyshortcuts]')].map((el) => el.getAttribute('aria-keyshortcuts')),
  )
  expect(new Set(keys).size).toBe(keys.length)
  for (const digit of ['1', '2', '3', '4', '5']) {
    expect(keys).toContain(`Alt+${digit}`)
  }
  await expect(nav(page).locator('[aria-keyshortcuts]')).toHaveCount(0)
  await nav(page).getByRole('button', { name: 'General' }).focus()
  await page.keyboard.press('a')
  await expect(page).toHaveURL(/#settings\/general$/)
  await page.keyboard.press('Alt+3')
  await expect(page).toHaveURL(/#agents$/)
})
