import type { Locator, Page } from '@playwright/test'
import { expect, test, unique } from './support/fixtures.js'

const groupPanel = (page: Page) => page.getByRole('complementary', { name: 'Group chat' })

/** The text the field has selected. */
const selected = async (field: Locator) =>
  field.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd))

const DRAFT = 'Deploy the API, then tell the API team the API is live'

test('Ctrl+F in the group chat box finds and replaces, undoes, and leaves the chat find closed', async ({ page }) => {
  await page.goto('/#agents')
  await page.keyboard.press('Control+Shift+L')
  const panel = groupPanel(page)
  const composer = panel.getByRole('combobox', { name: 'Message the group' })
  await composer.fill(DRAFT)
  await composer.evaluate((el: HTMLTextAreaElement) => {
    el.setSelectionRange(0, 0)
  })

  await composer.press('Control+f')
  const field = panel.getByRole('searchbox', { name: 'Find in message' })
  await expect(field).toBeFocused()
  await expect(page.getByTestId('chat-find')).toHaveCount(0)
  await field.fill('api')
  const count = panel.getByTestId('message-find-count')
  await expect(count).toHaveText('1 of 3')
  expect(await selected(composer)).toBe('API')
  await page.keyboard.press('Enter')
  await expect(count).toHaveText('2 of 3')

  await page.keyboard.press('Escape')
  await expect(panel.getByTestId('message-find')).toHaveCount(0)
  await expect(composer).toBeFocused()
  await composer.press('Control+h')
  await expect(field).toBeFocused()
  const replacement = panel.getByRole('textbox', { name: 'Replace with' })
  await replacement.fill('service')
  await page.keyboard.press('Enter')
  await expect(count).toHaveText(/ of 2$/u)
  const once = await composer.inputValue()
  await panel.getByRole('button', { name: 'All', exact: true }).click()
  await expect(count).toHaveText('No matches')
  await expect(composer).toHaveValue('Deploy the service, then tell the service team the service is live')

  await page.keyboard.press('Escape')
  await expect(composer).toBeFocused()
  await page.keyboard.press('Control+z')
  await expect(composer).toHaveValue(once)
  await page.keyboard.press('Control+z')
  await expect(composer).toHaveValue(DRAFT)

  await panel.getByRole('log').first().click()
  await page.keyboard.press('Control+f')
  await expect(panel.getByTestId('chat-find')).toBeVisible()
  await expect(panel.getByTestId('message-find')).toHaveCount(0)
})

test('a context pack editor finds in its text while the group chat find stays closed', async ({ page }) => {
  await page.goto('/#context')
  await page.getByRole('button', { name: 'New context pack' }).click()
  await page.getByLabel('Name', { exact: true }).fill(unique('e2e-find-pack'))
  const body = page.getByLabel('Pack content')
  await body.fill(Array.from({ length: 80 }, (_, n) => `Rule ${String(n)}: keep the build green`).join('\n'))
  await page.keyboard.press('Control+Shift+L')
  await expect(groupPanel(page)).toBeVisible()

  await body.click()
  await body.evaluate((el: HTMLTextAreaElement) => {
    el.setSelectionRange(0, 0)
  })
  await page.keyboard.press('Control+f')
  const field = page.getByRole('searchbox', { name: 'Find in text' })
  await expect(field).toBeFocused()
  await expect(page.getByTestId('chat-find')).toHaveCount(0)
  await field.fill('rule 3')
  await expect(page.getByTestId('text-find-count')).toHaveText(/^1 of 11$/u)
  expect(await selected(body)).toBe('Rule 3')
  await expect(page.getByTestId('field-find-marks')).toBeVisible()
  await page.keyboard.press('Shift+Enter')
  await expect(page.getByTestId('text-find-count')).toHaveText('11 of 11')
  expect(await selected(body)).toBe('Rule 3')
  await expect.poll(async () => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('text-find')).toHaveCount(0)
  await expect(body).toBeFocused()
})

test('a reminder script finds, replaces and goes to a line, and Esc closes find but not the dialog', async ({
  page,
}) => {
  await page.goto('/#settings/channels')
  await page.getByRole('main').getByRole('button', { name: 'New', exact: true }).click()
  await page
    .getByRole('list', { name: 'Channel sources' })
    .getByRole('button', { name: /Reminder/ })
    .click()
  const dialog = page.getByRole('dialog', { name: 'New reminder' })
  await expect(dialog.locator('[data-code-editor] .cm-content')).toBeVisible()
  const script = dialog.getByRole('textbox', { name: 'Script' })
  await script.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type("const note = 'note'\nexport default () => note + ' and note'")

  await page.keyboard.press('Control+f')
  const field = dialog.getByRole('searchbox', { name: 'Find in text' })
  await expect(field).toBeFocused()
  await field.fill('note')
  const count = dialog.getByTestId('text-find-count')
  await expect(count).toHaveText(/ of 4$/u)
  await expect(dialog.locator('.cm-findMatch-current')).toHaveCount(1)

  await page.keyboard.press('Control+h')
  await dialog.getByRole('textbox', { name: 'Replace with' }).fill('memo')
  await dialog.getByRole('button', { name: 'All', exact: true }).click()
  await expect(count).toHaveText('No matches')
  const lines = dialog.locator('.cm-line')
  await expect(lines).toHaveText(["const memo = 'memo'", "export default () => memo + ' and memo'"])

  await page.keyboard.press('Escape')
  await expect(dialog.getByTestId('text-find')).toHaveCount(0)
  await expect(dialog).toBeVisible()
  await expect(script).toBeFocused()

  await page.keyboard.press('Control+g')
  const line = dialog.getByRole('textbox', { name: 'Go to line' })
  await expect(line).toBeFocused()
  await line.fill('2')
  await page.keyboard.press('Enter')
  await expect(script).toBeFocused()
  await page.keyboard.type('// ')
  await expect(lines).toHaveText(["const memo = 'memo'", "// export default () => memo + ' and memo'"])

  await page.keyboard.press('Control+z')
  await expect(lines).toHaveText(["const memo = 'memo'", "export default () => memo + ' and memo'"])
  await page.keyboard.press('Control+z')
  await expect(lines).toHaveText(["const note = 'note'", "export default () => note + ' and note'"])
})

test('a settings text area takes Ctrl+F too', async ({ page }) => {
  await page.goto('/#settings/sandbox')
  const hosts = page.getByRole('textbox', { name: 'Allowed hosts' })
  await hosts.click()
  await page.keyboard.press('Control+f')
  await expect(page.getByRole('searchbox', { name: 'Find in text' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(hosts).toBeFocused()
  await expect(page.getByTestId('text-find')).toHaveCount(0)
})
