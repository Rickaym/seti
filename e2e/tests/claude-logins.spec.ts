import {
  accountItem,
  activeLoginName,
  fakeToken,
  hostAccessToken,
  LOGINS_ENV,
  savedLogins,
  signInAs,
} from './support/claude-logins.js'
import { SESSION_PROMPT } from './support/fake-claude.js'
import { expect, test, toasts } from './support/fixtures.js'
import { startSessionAgent, transcript } from './support/restart.js'

test.use({ serverEnv: LOGINS_ENV })

test('saves two logins, switches from the status bar and Ctrl+K, and restarts an agent on its next turn', async ({
  page,
  request,
}) => {
  await savedLogins(request)
  signInAs('work')
  await page.goto('/#settings/account')
  const main = page.getByRole('main')
  const logins = main.getByRole('region', { name: 'Saved logins' })
  const unsaved = logins.getByTestId('unsaved-login')
  await expect(unsaved).toContainText('Claude Code is logged in to work@e2e.invalid')
  await unsaved.getByRole('textbox', { name: 'Current login name' }).fill('Work')
  await unsaved.getByRole('button', { name: 'Save' }).click()
  await expect(toasts(page).filter({ hasText: 'Saved Work' })).toBeVisible()
  await expect(logins.getByTestId('saved-login').filter({ hasText: 'Work' })).toContainText('In use')
  await expect(activeLoginName(page)).toHaveText('Work')

  signInAs('home')
  await page.reload()
  await expect(toasts(page).filter({ hasText: 'Claude Code is logged in to home@e2e.invalid' })).toBeVisible()
  await logins.getByRole('textbox', { name: 'Current login name' }).fill('Personal')
  await logins.getByTestId('unsaved-login').getByRole('button', { name: 'Save' }).click()
  await expect(logins.getByTestId('saved-login')).toHaveCount(2)
  await expect(activeLoginName(page)).toHaveText('Personal')

  const { id, session } = await startSessionAgent(request)
  await page.goto(`/#agents/${id}`)
  await expect(transcript(page)).toContainText(`Session ${session}, resumed none`)

  await accountItem(page).click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: 'Personal, in use' })).toBeVisible()
  await menu.getByRole('menuitem', { name: 'Switch to Work' }).click()
  await expect(toasts(page).filter({ hasText: 'Using Work' })).toBeVisible()
  await expect(activeLoginName(page)).toHaveText('Work')
  expect(hostAccessToken()).toBe(fakeToken('work', 'access'))

  const reply = page.getByRole('main').getByRole('combobox', { name: 'Reply' })
  await reply.fill(`And now, ${SESSION_PROMPT}?`)
  await reply.press('Enter')
  await expect(transcript(page)).toContainText(`Session ${session}, resumed ${session}`)

  await page.keyboard.press('Control+k')
  await page.keyboard.type('>switch to personal')
  await page.keyboard.press('Enter')
  await expect(toasts(page).filter({ hasText: 'Using Personal' })).toBeVisible()
  await expect(activeLoginName(page)).toHaveText('Personal')
  expect(hostAccessToken()).toBe(fakeToken('home', 'access'))

  await page.keyboard.press('Alt+a')
  await expect(menu.getByRole('menuitem', { name: 'Personal, in use' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  const final = await savedLogins(request)
  expect(final.accounts.map((login) => login.name)).toEqual(['Personal', 'Work'])
  expect(JSON.stringify(final)).not.toContain(fakeToken('work', 'access'))
})

test('refuses removing the login in use and removes another after confirmation', async ({ page, request }) => {
  await savedLogins(request)
  signInAs('solo')
  await page.goto('/#settings/account')
  const logins = page.getByRole('main').getByRole('region', { name: 'Saved logins' })
  await logins.getByRole('textbox', { name: 'Current login name' }).fill('Solo')
  await logins.getByTestId('unsaved-login').getByRole('button', { name: 'Save' }).click()
  const solo = logins.getByTestId('saved-login').filter({ hasText: 'Solo' })
  await expect(solo.getByRole('button', { name: 'Remove' })).toBeDisabled()

  signInAs('spare')
  await page.reload()
  await logins.getByRole('textbox', { name: 'Current login name' }).fill('Spare')
  await logins.getByTestId('unsaved-login').getByRole('button', { name: 'Save' }).click()
  await solo.getByRole('button', { name: 'Remove' }).click()
  await page.getByRole('dialog', { name: 'Confirm' }).getByRole('button', { name: 'Remove' }).click()
  await expect(solo).toHaveCount(0)
})
