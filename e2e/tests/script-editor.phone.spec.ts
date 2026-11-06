import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import type { ChannelInfo, ReminderChannelInfo } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

async function openNewReminder(page: Page): Promise<Locator> {
  await page.goto('/#settings/channels')
  await page.getByRole('main').getByRole('button', { name: 'New', exact: true }).tap()
  await page
    .getByRole('list', { name: 'Channel sources' })
    .getByRole('button', { name: /Reminder/ })
    .tap()
  const dialog = page.getByRole('dialog', { name: 'New reminder' })
  await expect(dialog.locator('[data-code-editor] .tok-keyword').first()).toHaveText('export')
  return dialog
}

const zoom = async (page: Page) => page.evaluate(() => window.visualViewport?.scale ?? 1)

test('the script editor takes a tap and typing on a phone without zooming the page', async ({ page, request }) => {
  const name = `Phone script ${randomUUID().slice(0, 8)}`
  const dialog = await openNewReminder(page)
  await expectFitsPhone(page, 'reminder editor')
  const script = dialog.getByRole('textbox', { name: 'Script' })
  expect(await script.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16)

  await script.tap()
  await expect(script).toBeFocused()
  expect(await zoom(page)).toBe(1)
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.insertText("export default () => 'From a phone'")
  await expect(script).toHaveText("export default () => 'From a phone'")
  await expect(dialog.locator('[data-code-editor] .tok-string')).toHaveText("'From a phone'")

  await dialog.getByRole('button', { name: 'Test run' }).tap()
  await expect(dialog.getByRole('region', { name: 'Test run result' })).toContainText('From a phone')
  await dialog.getByRole('textbox', { name: 'Name' }).fill(name)
  await dialog.getByRole('button', { name: 'Create' }).tap()
  await expect(dialog).toBeHidden()
  const id = (await apiData<ChannelInfo[]>(request, '/channels')).find((info) => info.name === name)?.id ?? ''
  try {
    expect(id).not.toBe('')
    expect((await apiData<ReminderChannelInfo>(request, `/channels/reminders/${id}`)).reminder.script).toBe(
      "export default () => 'From a phone'",
    )
  } finally {
    await request.delete(`/api/channels/${id}`)
  }
})

test('an IME composition in the script editor commits once, as Gboard types', async ({ page }) => {
  const dialog = await openNewReminder(page)
  const script = dialog.getByRole('textbox', { name: 'Script' })
  await script.tap()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Delete')
  await expect(script).toHaveText('')

  const cdp = await page.context().newCDPSession(page)
  for (const word of ['const', 'greeting']) {
    for (let i = 1; i <= word.length; i++) {
      await cdp.send('Input.imeSetComposition', { text: word.slice(0, i), selectionStart: i, selectionEnd: i })
    }
    await cdp.send('Input.insertText', { text: word })
    await cdp.send('Input.insertText', { text: ' ' })
  }
  await expect(script).toHaveText('const greeting ')
  await expect(dialog.locator('[data-code-editor] .tok-keyword')).toHaveText('const')
})
