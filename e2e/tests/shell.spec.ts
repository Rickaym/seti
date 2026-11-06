import type { Locator } from '@playwright/test'
import { expect, test } from './support/fixtures.js'

const panelHeading = (label: string) => (main: Locator) => main.getByRole('heading', { name: label, level: 1 })

const SECTIONS = [
  { label: 'EA', hash: '#ea', title: panelHeading('EA') },
  { label: 'Home', hash: '#home', title: panelHeading('Home') },
  { label: 'Context', hash: '#context', title: panelHeading('Context') },
  { label: 'Settings', hash: '#settings', title: panelHeading('Settings') },
  { label: 'Agents', hash: '#agents', title: panelHeading('Agents') },
]

test('sidebar navigates to every section', async ({ page }) => {
  await page.goto('/')
  const sidebar = page.getByRole('complementary')
  const main = page.getByRole('main')
  for (const section of SECTIONS) {
    await sidebar.getByRole('button', { name: section.label, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`${section.hash}$`))
    await expect(section.title(main)).toBeVisible()
  }
})

test('Alt with a section digit opens it, numbered down the sidebar, and bare digits do not', async ({ page }) => {
  await page.goto('/#agents')
  const sidebar = page.getByRole('navigation', { name: 'Sections' })
  const labels = await sidebar
    .getByRole('button')
    .evaluateAll((buttons) =>
      buttons.map((button) => [button.getAttribute('aria-label'), button.getAttribute('aria-keyshortcuts')]),
    )
  expect(labels).toEqual([
    ['EA', 'Alt+1'],
    ['Home', 'Alt+2'],
    ['Agents', 'Alt+3'],
    ['Context', 'Alt+4'],
    ['Settings', 'Alt+5'],
  ])
  await page.getByRole('heading', { name: 'Agents', exact: true }).click()
  await page.keyboard.press('4')
  await expect(page).toHaveURL(/#agents$/)
  await page.keyboard.press('Alt+6')
  await expect(page).toHaveURL(/#agents$/)
  await page.keyboard.press('Alt+4')
  await expect(page).toHaveURL(/#context$/)
  await page.keyboard.press('Alt+5')
  await expect(page).toHaveURL(/#settings$/)
  await page.keyboard.press('Alt+1')
  await expect(page).toHaveURL(/#ea$/)
  await expect(page.getByRole('main').getByRole('heading', { name: 'EA', level: 1 })).toBeVisible()
  await page.keyboard.press('Alt+2')
  await expect(page).toHaveURL(/#home$/)
  await expect(page.getByRole('main').getByRole('heading', { name: 'Home', level: 1 })).toBeVisible()
  await page.keyboard.press('Alt+3')
  await expect(page).toHaveURL(/#agents$/)
  await sidebar.getByRole('button', { name: 'Context', exact: true }).hover()
  await expect(page.getByRole('tooltip')).toHaveText('ContextAlt+4')
})

test('deep links open the matching section', async ({ page }) => {
  for (const section of SECTIONS) {
    await page.goto(`/${section.hash}`)
    await expect(section.title(page.getByRole('main'))).toBeVisible()
  }
})

test('Seti opens on Home with the EA first in the sidebar, and a #home link opens Home', async ({ page }) => {
  await page.goto('/')
  const sections = page.getByRole('navigation', { name: 'Sections' }).getByRole('button')
  await expect(sections.first()).toHaveAccessibleName('EA')
  await expect(sections.nth(1)).toHaveAccessibleName('Home')
  await expect(sections.nth(1)).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('main').getByRole('heading', { name: 'Home', level: 1 })).toBeVisible()
  await page.goto('/#agents')
  await page.goto('/#home')
  await expect(page).toHaveURL(/#home$/)
  await expect(page.getByRole('main').getByRole('heading', { name: 'Home', level: 1 })).toBeVisible()
})

test('old #tasks hashes land on #agents without a history entry', async ({ page }) => {
  await page.goto('/#tasks')
  await expect(page).toHaveURL(/#agents$/)
  await expect(page.getByRole('main').getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()

  await page.goto('/#settings')
  await page.evaluate(() => {
    window.location.hash = 'tasks/missing/sub/toolu_missing'
  })
  await expect(page).toHaveURL(/#agents\/missing\/sub\/toolu_missing$/)
  await page.goBack()
  await expect(page).toHaveURL(/#settings$/)
})

test('old #prs links land on Agents without errors, and the rail has no PRs item', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/#prs')
  await expect(page).toHaveURL(/#agents$/)
  await expect(page.getByRole('main').getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
  await page.goto('/#prs/seti-42')
  await expect(page).toHaveURL(/#agents$/)

  await page.goto('/#context')
  await page.evaluate(() => {
    window.location.hash = 'prs/seti-42'
  })
  await expect(page).toHaveURL(/#agents$/)
  await page.goBack()
  await expect(page).toHaveURL(/#context$/)
  await expect(page.getByRole('complementary').getByRole('button', { name: 'Pull requests' })).toHaveCount(0)
  await expect(page.getByRole('contentinfo').getByLabel('Open pull requests')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('status bar shows the work and health groups and the API item', async ({ page }) => {
  await page.goto('/')
  const bar = page.getByRole('contentinfo')
  await expect(bar.getByRole('group', { name: 'Work' })).toBeVisible()
  await expect(bar.getByRole('group', { name: 'Health' })).toBeVisible()
  await expect(bar.getByRole('status', { name: 'API up' })).toBeVisible()
  await expect(bar.getByRole('status', { name: 'Permission mode auto' })).toBeVisible()
})

test('theme toggle switches and remembers the dark class', async ({ page }) => {
  await page.goto('/')
  const html = page.locator('html')
  const toggle = page.getByRole('button', { name: 'Dark mode', exact: true })
  await expect(html).toHaveClass(/\blight\b/)
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.hover()
  await expect(page.getByRole('tooltip')).toHaveText('Dark mode')
  await toggle.click()
  await expect(html).toHaveClass(/\bdark\b/)
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await page.reload()
  await expect(html).toHaveClass(/\bdark\b/)
  await toggle.click()
  await expect(html).not.toHaveClass(/\bdark\b/)
})
