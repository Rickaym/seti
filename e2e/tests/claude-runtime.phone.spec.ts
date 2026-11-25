import { LOGINS_ENV, savedLogins, signInAs } from './support/claude-logins.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone, expectTouchTarget } from './support/phone-layout.js'

test.use({ serverEnv: LOGINS_ENV })

test('a phone reads the Claude Code card on Runtimes, from an old Account link too', async ({ page, request }) => {
  await savedLogins(request)
  signInAs('work')
  await page.goto('/#settings/account')
  await expect(page).toHaveURL(/#settings\/runtimes$/)
  const claude = page.getByRole('main').getByRole('region', { name: 'Claude Code' })
  await expect(claude.getByRole('status')).toHaveText('Ready')
  await expect(claude).toBeInViewport()
  await expectTouchTarget(claude.getByRole('button', { name: 'Recheck' }))
  await expect(
    claude.getByRole('region', { name: 'Plan usage' }),
    'state, login and usage on the first screen',
  ).toBeInViewport({
    ratio: 1,
  })
  await claude.getByRole('button', { name: 'About saved logins' }).tap()
  await expect(page.getByText('Agent credentials hold no Claude login')).toBeVisible()
  await page.keyboard.press('Escape')
  await expectFitsPhone(page, 'Runtimes with the Claude Code card')
  const credentials = claude.getByRole('button', { name: 'Credentials' })
  await credentials.scrollIntoViewIfNeeded()
  await expectTouchTarget(credentials)
  await expectFitsPhone(page, 'Claude Code token, program and model')

  await claude.getByRole('button', { name: 'Log in' }).tap()
  await expect(claude.getByRole('textbox', { name: 'New login name' })).toBeVisible()
  await expectFitsPhone(page, 'Claude Code card adding a login')
})

test('a phone opens Claude Code subagents and models and they fit', async ({ page }) => {
  await page.goto('/#settings/runtimes')
  const section = page.getByRole('main').getByRole('region', { name: 'Subagents and models' })
  const toggle = section.getByRole('button', { name: 'Subagents and models' })
  await expectTouchTarget(toggle)
  await toggle.tap()
  await expect(section.getByRole('region', { name: 'Subagents' })).toBeVisible({ timeout: 30_000 })
  await expectFitsPhone(page, 'Claude Code subagents and models')
})
