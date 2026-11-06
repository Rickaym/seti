import { randomUUID } from 'node:crypto'
import { flavors, type ColorName } from '@catppuccin/palette'
import type { Page } from '@playwright/test'
import type { UserSettings } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test } from './support/fixtures.js'
import { modToggle, recordedThemes, recordThemes, resetThemes } from './support/themes.js'

const TITLE = 'Theme check task'
const taskId = randomUUID()

type FlavourName = keyof typeof flavors

const rgb = (flavour: FlavourName, name: ColorName) => {
  const { r, g, b } = flavors[flavour].colors[name].rgb
  return `rgb(${String(r)}, ${String(g)}, ${String(b)})`
}

interface Sample {
  background: string
  header: string
  button: string
  buttonText: string
  pill: string
  pillText: string
}

async function sample(page: Page): Promise<Sample> {
  await page.goto(`/#agents/${taskId}`)
  const main = page.getByRole('main')
  const button = main.getByRole('button', { name: 'New agent', exact: true })
  const pill = main.getByRole('heading', { name: TITLE }).locator('..').getByText('stopped', { exact: true })
  await expect(button).toBeVisible()
  await expect(pill).toBeVisible()
  const style = async (locator: typeof button, property: string) =>
    locator.evaluate((node, name) => getComputedStyle(node).getPropertyValue(name), property)
  return {
    background: await style(page.locator('body'), 'background-color'),
    header: await style(page.locator('header').first(), 'background-color'),
    button: await style(button, 'background-color'),
    buttonText: await style(button, 'color'),
    pill: await style(pill, 'background-color'),
    pillText: await style(pill, 'color'),
  }
}

const CATPPUCCIN = 'catppuccin.catppuccin'
const CLAUDE = 'claude-theme.claude'

/** Latte darkens its accents so text on them and in them passes AA; see mods/catppuccin. */
const LATTE_DEEP: Partial<Record<ColorName, string>> = {
  mauve: 'rgb(128, 44, 228)',
  teal: 'rgb(3, 109, 115)',
  yellow: 'rgb(139, 85, 1)',
}

const expected = (flavour: FlavourName, accent: ColorName = 'mauve'): Sample => ({
  background: rgb(flavour, 'base'),
  header: rgb(flavour, 'mantle'),
  button: flavour === 'latte' ? (LATTE_DEEP[accent] ?? '') : rgb(flavour, accent),
  buttonText: rgb(flavour, 'base'),
  pill: rgb(flavour, 'crust'),
  pillText: rgb(flavour, flavour === 'latte' || flavour === 'frappe' ? 'subtext1' : 'subtext0'),
})

const general = (page: Page) => page.getByRole('main')

async function expectTitleBar(page: Page, flavour: FlavourName): Promise<void> {
  for (const meta of await page.locator('meta[name="theme-color"]').all()) {
    await expect(meta).toHaveAttribute('content', flavors[flavour].colors.mantle.hex)
  }
}

async function choose(page: Page, group: string, name: string): Promise<void> {
  await page.goto('/#settings/general')
  const button = general(page).getByRole('group', { name: group }).getByRole('button', { name, exact: true })
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
}

test.afterEach(async ({ request }) => {
  await resetThemes(request)
})

test.beforeAll(async () => {
  const db = openSeedDb()
  await db.idleTask(taskId, TITLE, paths.checkout, new Date().toISOString())
  await db.run(`UPDATE task SET status = 'stopped' WHERE id = ?`, taskId)
  await db.close()
})

test('catppuccin uses latte for light and the chosen flavour for dark', async ({ page }) => {
  await page.goto('/#settings/general')
  await expect(general(page).getByRole('group', { name: 'Dark flavour' })).toHaveCount(0)
  await choose(page, 'Theme', 'Catppuccin')
  await expect(page.locator('html')).toHaveAttribute('data-theme', CATPPUCCIN)
  await expect(page.locator('html')).toHaveAttribute('data-flavour', 'mocha')
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'mauve')
  expect(await sample(page)).toEqual(expected('latte'))
  await expectTitleBar(page, 'latte')

  await choose(page, 'Color mode', 'Dark')
  expect(await sample(page)).toEqual(expected('mocha'))
  await expectTitleBar(page, 'mocha')
  for (const [label, flavour] of [
    ['Frappe', 'frappe'],
    ['Macchiato', 'macchiato'],
    ['Mocha', 'mocha'],
  ] as const) {
    await choose(page, 'Dark flavour', label)
    expect(await sample(page), label).toEqual(expected(flavour))
    await expectTitleBar(page, flavour)
  }
})

test('the accent drives primary colours and every choice survives a reload', async ({ page }) => {
  await choose(page, 'Theme', 'Catppuccin')
  await choose(page, 'Accent', 'Teal')
  expect(await sample(page)).toEqual(expected('latte', 'teal'))
  await choose(page, 'Accent', 'Yellow')
  expect(await sample(page)).toEqual(expected('latte', 'yellow'))

  await choose(page, 'Color mode', 'Dark')
  await choose(page, 'Dark flavour', 'Frappe')
  await choose(page, 'Accent', 'Teal')
  await page.reload()
  const html = page.locator('html')
  await expect(html).toHaveAttribute('data-theme', CATPPUCCIN)
  await expect(html).toHaveAttribute('data-flavour', 'frappe')
  await expect(html).toHaveAttribute('data-accent', 'teal')
  await expect(html).toHaveClass(/\bdark\b/)
  expect(await sample(page)).toEqual(expected('frappe', 'teal'))
  await page.goto('/#settings/general')
  for (const [group, name] of [
    ['Theme', 'Catppuccin'],
    ['Dark flavour', 'Frappe'],
    ['Accent', 'Teal'],
  ] as const) {
    await expect(general(page).getByRole('group', { name: group }).getByRole('button', { name })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  }
})

test('claude paints cream and a deep orange when light, charcoal and the Claude orange when dark', async ({ page }) => {
  await choose(page, 'Theme', 'Claude')
  const html = page.locator('html')
  await expect(html).toHaveAttribute('data-theme', CLAUDE)
  await expect(html).not.toHaveAttribute('data-accent')
  await expect(general(page).getByRole('group', { name: 'Accent' })).toHaveCount(0)
  expect(await sample(page)).toEqual({
    background: 'rgb(250, 249, 245)',
    header: 'rgb(240, 238, 230)',
    button: 'rgb(177, 69, 30)',
    buttonText: 'rgb(255, 255, 255)',
    pill: 'rgb(233, 231, 222)',
    pillText: 'rgb(94, 93, 89)',
  })
  for (const meta of await page.locator('meta[name="theme-color"]').all()) {
    await expect(meta).toHaveAttribute('content', '#f0eee6')
  }

  await choose(page, 'Color mode', 'Dark')
  await page.reload()
  await expect(html).toHaveAttribute('data-theme', CLAUDE)
  expect(await sample(page)).toEqual({
    background: 'rgb(38, 38, 36)',
    header: 'rgb(31, 30, 29)',
    button: 'rgb(217, 119, 87)',
    buttonText: 'rgb(20, 20, 19)',
    pill: 'rgb(20, 20, 19)',
    pillText: 'rgb(166, 163, 154)',
  })
  for (const meta of await page.locator('meta[name="theme-color"]').all()) {
    await expect(meta).toHaveAttribute('content', '#1f1e1d')
  }
})

test('switching back to default restores the exact default colours', async ({ page }) => {
  const light = await sample(page)
  await choose(page, 'Color mode', 'Dark')
  const dark = await sample(page)
  expect(dark).not.toEqual(light)

  await choose(page, 'Theme', 'Catppuccin')
  await choose(page, 'Dark flavour', 'Macchiato')
  await choose(page, 'Accent', 'Pink')
  expect(await sample(page)).toEqual(expected('macchiato', 'pink'))

  await choose(page, 'Theme', 'Default')
  const html = page.locator('html')
  await expect(html).toHaveAttribute('data-theme', 'default')
  await expect(html).not.toHaveAttribute('data-flavour')
  await expect(html).not.toHaveAttribute('data-accent')
  await expect(general(page).getByRole('group', { name: 'Accent' })).toHaveCount(0)
  expect(await sample(page)).toEqual(dark)
  await choose(page, 'Color mode', 'Light')
  expect(await sample(page)).toEqual(light)
  await page.reload()
  expect(await sample(page)).toEqual(light)
})

test("a theme mod turned off shows the default at once, and the user's theme returns with it", async ({ page }) => {
  await choose(page, 'Theme', 'Catppuccin')
  await choose(page, 'Color mode', 'Dark')
  await choose(page, 'Dark flavour', 'Frappe')
  await choose(page, 'Accent', 'Teal')
  const html = page.locator('html')

  await page.goto('/#settings/mods')
  await recordThemes(page)
  await modToggle(page, 'Catppuccin').click()
  await expect(modToggle(page, 'Catppuccin')).toHaveAttribute('aria-pressed', 'false')
  await expect(html).toHaveAttribute('data-theme', 'default')
  await expect(html).not.toHaveAttribute('data-flavour')
  await expect(html).not.toHaveAttribute('data-accent')
  expect(await recordedThemes(page)).toEqual(['default'])
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)

  await page.goto('/#settings/general')
  const themes = general(page).getByRole('group', { name: 'Theme' })
  await expect(themes.getByRole('button', { name: 'Catppuccin' })).toHaveCount(0)
  await expect(themes.getByRole('button', { name: 'Default' })).toHaveAttribute('aria-pressed', 'true')
  await recordThemes(page, true)
  await page.reload()
  await expect(themes.getByRole('button', { name: 'Default' })).toHaveAttribute('aria-pressed', 'true')
  expect(await recordedThemes(page)).toEqual(['default'])

  await page.goto('/#settings/mods')
  await modToggle(page, 'Catppuccin').click()
  await expect(html).toHaveAttribute('data-theme', CATPPUCCIN)
  await expect(html).toHaveAttribute('data-flavour', 'frappe')
  await expect(html).toHaveAttribute('data-accent', 'teal')
  expect(await sample(page)).toEqual(expected('frappe', 'teal'))
})

test('the theme is kept by Seti for every device and paints on load without the default first', async ({ page }) => {
  await choose(page, 'Theme', 'Claude')
  await recordThemes(page, true)
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', CLAUDE)
  expect(await recordedThemes(page)).toEqual([CLAUDE])

  await page.evaluate(() => {
    localStorage.clear()
  })
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', CLAUDE)
})

test('a theme this browser kept before Seti held it moves to Seti once', async ({ page, request }) => {
  const db = openSeedDb()
  await db.run('UPDATE user_settings SET theme = NULL')
  await db.close()
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded') === null) {
      sessionStorage.setItem('seeded', '1')
      localStorage.setItem('seti-ui-theme-id', 'catppuccin')
      localStorage.setItem('seti-ui-theme-flavour', 'macchiato')
      localStorage.setItem('seti-ui-theme-accent', 'pink')
    }
  })
  await page.goto('/#settings/general')
  await expect(page.locator('html')).toHaveAttribute('data-theme', CATPPUCCIN)
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'pink')
  const kept = { id: CATPPUCCIN, flavour: 'macchiato', accent: 'pink' }
  await expect.poll(async () => (await apiData<UserSettings>(request, '/user')).theme).toEqual(kept)
  expect(await page.evaluate(() => localStorage.getItem('seti-ui-theme-id'))).toBeNull()
})
