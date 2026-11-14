import { expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test('the group chat box has a Find button on a phone that finds and replaces, and it fits', async ({ page }) => {
  await page.goto('/#agents')
  await page.getByRole('banner').getByTestId('team-chat-toggle').tap()
  const sheet = page.getByRole('dialog', { name: 'Group chat' })
  const composer = sheet.getByRole('combobox', { name: 'Message the group' })
  await composer.fill('Ship the fix, then say the fix is out')

  await sheet.getByRole('button', { name: 'Find', exact: true }).tap()
  const field = sheet.getByRole('searchbox', { name: 'Find in message' })
  await expect(field).toBeFocused()
  await field.fill('fix')
  const count = sheet.getByTestId('message-find-count')
  await expect(count).toHaveText(/^\d of 2$/u)
  await expect(sheet.getByRole('button', { name: 'Close find' })).toBeInViewport()
  await expectFitsPhone(page, 'find in the group chat box')

  await sheet.getByRole('button', { name: 'Replace', exact: true }).tap()
  await sheet.getByRole('textbox', { name: 'Replace with' }).fill('patch')
  await sheet.getByRole('button', { name: 'All', exact: true }).tap()
  await expect(count).toHaveText('No matches')
  await expect(composer).toHaveValue('Ship the patch, then say the patch is out')
  await expectFitsPhone(page, 'find and replace in the group chat box')

  await sheet.getByRole('button', { name: 'Close find' }).tap()
  await expect(sheet.getByTestId('message-find')).toHaveCount(0)
  await expect(sheet).toBeVisible()
  await expect(composer).toBeFocused()
})

test('a context pack editor shows a Find button in its corner while it has focus on a phone', async ({ page }) => {
  await page.goto('/#context')
  await page.getByRole('button', { name: 'New context pack' }).tap()
  await page.getByLabel('Name', { exact: true }).fill(unique('e2e-phone-find'))
  const body = page.getByLabel('Pack content')
  const corner = page.getByRole('main').getByRole('button', { name: 'Find', exact: true })
  await expect(corner).toBeHidden()

  await body.fill(Array.from({ length: 20 }, (_, n) => `Step ${String(n)}: run the tests`).join('\n'))
  await expect(body).toBeFocused()
  await expect(corner).toBeVisible()
  await expectFitsPhone(page, 'the Find button in a pack editor')
  await corner.tap()
  const field = page.getByRole('searchbox', { name: 'Find in text' })
  await expect(field).toBeFocused()
  await expect(corner).toHaveCount(0)
  await field.fill('tests')
  await expect(page.getByTestId('text-find-count')).toHaveText(/^\d+ of 20$/u)
  await expectFitsPhone(page, 'find in a pack editor')

  await page.getByRole('button', { name: 'Close find' }).tap()
  await expect(page.getByTestId('text-find')).toHaveCount(0)
  await expect(body).toBeFocused()
  await expect(corner).toBeVisible()
})
