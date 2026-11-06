import {
  accountItem,
  activeLoginName,
  fakeToken,
  hostAccessToken,
  LOGINS_ENV,
  saveLogin,
  savedLogins,
} from './support/claude-logins.js'
import { expect, test, toasts } from './support/fixtures.js'

test.use({ serverEnv: LOGINS_ENV })

test('switches the Claude login from the status bar on a phone, and the logins fit the screen', async ({
  page,
  request,
}) => {
  await savedLogins(request)
  await saveLogin(request, 'work', 'Work')
  await saveLogin(request, 'home', 'Personal')

  await page.goto('/#settings/account')
  const logins = page.getByRole('main').getByRole('region', { name: 'Saved logins' })
  await expect(logins.getByTestId('saved-login')).toHaveCount(2)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
  await expect(activeLoginName(page)).toHaveText('Personal')

  await accountItem(page).tap()
  const work = page.getByRole('menu').getByRole('menuitem', { name: 'Switch to Work' })
  await expect.poll(async () => (await work.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await work.tap()
  await expect(toasts(page).filter({ hasText: 'Using Work' })).toBeVisible()
  await expect(activeLoginName(page)).toHaveText('Work')
  expect(hostAccessToken()).toBe(fakeToken('work', 'access'))

  await logins.getByTestId('saved-login').filter({ hasText: 'Personal' }).getByRole('button', { name: 'Use' }).tap()
  await expect(toasts(page).filter({ hasText: 'Using Personal' })).toBeVisible()
  expect(hostAccessToken()).toBe(fakeToken('home', 'access'))
})
