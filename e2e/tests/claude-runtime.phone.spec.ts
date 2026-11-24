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
  await expectFitsPhone(page, 'Runtimes with the Claude Code card')

  await claude.getByRole('button', { name: 'Log in' }).tap()
  await expect(claude.getByRole('textbox', { name: 'New login name' })).toBeVisible()
  await expectFitsPhone(page, 'Claude Code card adding a login')
})
