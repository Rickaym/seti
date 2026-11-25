import { LOGINS_ENV, savedLogins, signInAs } from './support/claude-logins.js'
import { expect, test } from './support/fixtures.js'

test.use({ serverEnv: LOGINS_ENV })

test('Runtimes holds Claude Code above Codex: its state, login, saved logins and usage', async ({ page, request }) => {
  await savedLogins(request)
  signInAs('work')
  await page.goto('/#settings/runtimes')
  const main = page.getByRole('main')
  const claude = main.getByRole('region', { name: 'Claude Code' })
  await expect(claude.getByRole('status')).toHaveText('Ready')
  await expect(claude.getByRole('button', { name: 'Recheck' })).toBeVisible()
  const logins = claude.getByRole('region', { name: 'Saved logins' })
  await expect(logins.getByRole('button', { name: 'Log in' })).toBeVisible()
  await expect(claude.getByRole('region', { name: 'Plan usage' })).toBeVisible()

  const codex = main.getByRole('region', { name: 'Codex' })
  const [above, below] = await Promise.all([claude.boundingBox(), codex.boundingBox()])
  expect(above?.y ?? 0).toBeLessThan(below?.y ?? 0)
  await expect(
    page.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Account' }),
  ).toHaveCount(0)
})

test('the palette finds the Claude login and usage on Runtimes', async ({ page }) => {
  await page.goto('/#agents')
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Search Seti' })
  await expect(palette.getByRole('combobox')).toBeFocused()
  await page.keyboard.type('plan usage')
  await palette.getByRole('option', { name: /^Runtimes\b/ }).click()
  await expect(page).toHaveURL(/#settings\/runtimes$/)
})

test("the Claude Code card shows the agents' token, the program and its default model, and links to Credentials", async ({
  page,
  request,
}) => {
  await savedLogins(request)
  signInAs('work')
  await page.goto('/#settings/runtimes')
  const claude = page.getByRole('main').getByRole('region', { name: 'Claude Code' })
  await expect(claude).toContainText("Sandboxed agents use this machine's login")
  await expect(claude).toContainText("from Claude Code's settings")
  await expect(claude.getByText(/^(\d+\.\d+\.\d|Version unknown)/)).toBeVisible()
  await claude.getByRole('button', { name: 'Credentials' }).click()
  await expect(page).toHaveURL(/#settings\/credentials$/)
  await expect(page.locator('#secrets')).toBeInViewport()
})

test('an old Subagents link opens Claude Code subagents and models on Runtimes', async ({ page }) => {
  await page.goto('/#settings/subagents')
  await expect(page).toHaveURL(/#settings\/runtimes$/)
  const section = page.getByRole('main').getByRole('region', { name: 'Subagents and models' })
  await expect(section.getByRole('button', { name: 'Subagents and models' })).toHaveAttribute('aria-expanded', 'true')
  await expect(section.getByRole('region', { name: 'Models' })).toBeVisible({ timeout: 30_000 })
  await expect(section).toBeInViewport()
})
