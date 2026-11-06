import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import type { ChannelInfo, PollerChannelInfo, ReminderChannelInfo } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'
import { setModEnabled } from './support/mods.js'

async function openNew(page: Page, source: RegExp, title: string): Promise<Locator> {
  await page.goto('/#settings/channels')
  await page.getByRole('main').getByRole('button', { name: 'New', exact: true }).click()
  await page.getByRole('list', { name: 'Channel sources' }).getByRole('button', { name: source }).click()
  return page.getByRole('dialog', { name: title })
}

/** The script field once CodeMirror has replaced the stand-in textarea. */
async function scriptEditor(dialog: Locator): Promise<Locator> {
  await expect(dialog.locator('[data-code-editor] .cm-content')).toBeVisible()
  return dialog.getByRole('textbox', { name: 'Script' })
}

const TYPED = "export default () => 'Typed in the editor'"

test('the reminder script is highlighted, typed into, test run and saved as typed', async ({ page, request }) => {
  const name = `E2E typed ${randomUUID().slice(0, 8)}`
  const dialog = await openNew(page, /Reminder/, 'New reminder')
  const script = await scriptEditor(dialog)
  const editor = dialog.locator('[data-code-editor]')
  await expect(editor.locator('.tok-keyword').first()).toHaveText('export')
  await expect(editor.locator('.tok-string').first()).toHaveText(
    "'Check the open pull requests and say which ones wait on you.'",
  )
  await expect(editor.locator('.tok-literal', { hasText: 'null' })).toHaveCount(1)
  await expect(editor.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^1$/ })).toBeVisible()

  await script.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type(TYPED)
  await expect(editor.locator('.tok-string')).toHaveText("'Typed in the editor'")
  await dialog.getByRole('button', { name: 'Test run' }).click()
  await expect(dialog.getByTestId('reminder-test-status')).toContainText('Would deliver')
  await expect(dialog.getByRole('region', { name: 'Test run result' })).toContainText('Typed in the editor')

  await dialog.getByRole('textbox', { name: 'Name' }).fill(name)
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  const id = (await apiData<ChannelInfo[]>(request, '/channels')).find((info) => info.name === name)?.id ?? ''
  try {
    expect(id).not.toBe('')
    expect((await apiData<ReminderChannelInfo>(request, `/channels/reminders/${id}`)).reminder.script).toBe(TYPED)
  } finally {
    await request.delete(`/api/channels/${id}`)
  }
})

test('Tab indents in the script, Shift-Tab outdents, and Esc then Tab leaves it', async ({ page }) => {
  const dialog = await openNew(page, /Reminder/, 'New reminder')
  const script = await scriptEditor(dialog)
  await script.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('return 1')
  await page.keyboard.press('Home')
  await page.keyboard.press('Tab')
  await expect(script).toHaveText('  return 1')
  await expect(script).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(script).toHaveText('return 1')

  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(script).not.toBeFocused()
  await expect(script).toHaveText('return 1')
  await expect(dialog.getByText('Script API')).toBeFocused()
})

test('the poller script is highlighted and an edit to it is saved', async ({ page, request }) => {
  const name = `E2E typed poller ${randomUUID().slice(0, 8)}`
  const response = await request.post('/api/channels/pollers', {
    data: { name, script: 'export default async () => []', subscribe_ea: false },
  })
  expect(response.ok()).toBe(true)
  const created = ((await response.json()) as { data: PollerChannelInfo }).data
  try {
    await page.goto('/#settings/channels')
    await page.getByRole('main').getByRole('region', { name }).getByRole('button', { name: 'Edit' }).click()
    const dialog = page.getByRole('dialog', { name: `Edit ${name}` })
    const script = await scriptEditor(dialog)
    const editor = dialog.locator('[data-code-editor]')
    await expect(editor.locator('.tok-keyword')).toHaveText(['export', 'default', 'async'])

    await script.click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.type("{ key: 'a', title: 'Typed item' }")
    await expect(script).toHaveText("export default async () => [{ key: 'a', title: 'Typed item' }]")
    await expect(editor.locator('.cm-matchingBracket').first()).toBeVisible()
    await dialog.getByRole('button', { name: 'Test run' }).click()
    await expect(dialog.getByTestId('poller-test-status')).toHaveText(/^1 item in/)
    await expect(dialog.getByRole('list', { name: 'Test items' })).toContainText('Typed item')

    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()
    const saved = await apiData<PollerChannelInfo>(request, `/channels/pollers/${created.id}`)
    expect(saved.poller.script).toBe("export default async () => [{ key: 'a', title: 'Typed item' }]")
  } finally {
    await request.delete(`/api/channels/${created.id}`)
  }
})

test('with Vim mode on, keys typed in the script stay text', async ({ page, request }) => {
  await setModEnabled(request, 'vim', true)
  try {
    const dialog = await openNew(page, /Reminder/, 'New reminder')
    const script = await scriptEditor(dialog)
    await script.click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('jjkk G gg : ? /')
    await expect(script).toHaveText('jjkk G gg : ? /')
    await expect(page.getByTestId('vim-mode')).toHaveText(/INSERT/)
    await expect(page.getByRole('dialog', { name: 'Vim mode keys' })).toHaveCount(0)
    await expect(dialog).toBeVisible()
  } finally {
    await setModEnabled(request, 'vim', false)
  }
})
