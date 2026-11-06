import type { Page } from '@playwright/test'
import type { Envelope, Repo } from '@seti/shared'
import { paths } from './support/env.js'
import { apiData, expect, test, toasts, unique } from './support/fixtures.js'

test.use({ allowedHttpStatuses: [400] })

/** Also finds page buttons while a modal dialog hides the page from the accessibility tree. */
const pageButton = (page: Page, name: string) =>
  page.locator('main').getByRole('button', { name, exact: true, includeHidden: true })

const importDialog = (page: Page) => page.getByRole('dialog', { name: 'Import sessions' })

/** Underlined access letters, whether drawn as CSS highlights or as markup inside a control. */
async function mnemonicMarks(page: Page): Promise<number> {
  return page.evaluate(() => {
    const highlighted = [...CSS.highlights.keys()].filter(
      (name) => name !== 'seti-find' && name !== 'seti-find-current',
    )
    const marked = document.querySelectorAll('button u, [role="button"] u, button [data-mnemonic], [accesskey]')
    return highlighted.length + marked.length
  })
}

async function openTasks(page: Page) {
  await page.goto('/#agents')
  const newButton = pageButton(page, 'New agent')
  await expect(newButton).toBeVisible()
  return newButton
}

test('icon buttons name their Alt chords and no control draws an access letter', async ({ page }) => {
  const newButton = await openTasks(page)
  await expect(newButton).toHaveAttribute('aria-keyshortcuts', 'Alt+N')
  await expect(newButton).toHaveText('')
  await pageButton(page, 'More list actions').click()
  const importItem = page.getByRole('menuitem', { name: 'Import sessions' })
  await expect(importItem).toHaveAttribute('aria-keyshortcuts', 'Alt+I')
  await expect(importItem).toContainText('Alt+I')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Dark mode' })).not.toHaveAttribute('aria-keyshortcuts')
  expect(await mnemonicMarks(page)).toBe(0)

  await page.goto('/#settings/general')
  await expect(page.getByRole('navigation', { name: 'Settings pages' })).toBeVisible()
  expect(await mnemonicMarks(page)).toBe(0)
  const lettered = await page.evaluate(() =>
    [...document.querySelectorAll('[aria-keyshortcuts]')]
      .map((el) => el.getAttribute('aria-keyshortcuts') ?? '')
      .filter((keys) => /^Alt\+[A-Z]$/.test(keys) && keys !== 'Alt+N' && keys !== 'Alt+I'),
  )
  expect(lettered).toEqual([])
})

test('bare letters type or do nothing; Alt chords act from anywhere, a field included', async ({ page }) => {
  await openTasks(page)
  await page.getByRole('heading', { name: 'Agents', exact: true }).click()
  await page.keyboard.press('n')
  await page.keyboard.press('i')
  await expect(page).toHaveURL(/#agents$/)
  await expect(importDialog(page)).toBeHidden()

  await page.goto('/#context')
  await expect(page.getByRole('main').getByRole('heading', { name: 'Context', level: 1 })).toBeVisible()
  await page.keyboard.press('Alt+n')
  await expect(page).toHaveURL(/#agents\/new$/)

  const message = page.getByLabel('Message')
  await message.fill('Shortcut check')
  await page.keyboard.type(' in')
  await expect(message).toHaveValue('Shortcut check in')
  await page.keyboard.press('Alt+i')
  await expect(importDialog(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(importDialog(page)).toBeHidden()
  await expect(message).toHaveValue('Shortcut check in')
  await expect(toasts(page)).toHaveCount(0)
  await message.fill('')
})

test('an open dialog keeps the app chords from the page behind it', async ({ page }) => {
  const newButton = await openTasks(page)
  await pageButton(page, 'More list actions').click()
  await page.getByRole('menuitem', { name: 'Import sessions' }).click()
  await expect(importDialog(page)).toBeVisible()
  await importDialog(page).getByRole('heading', { name: 'Import sessions' }).click()
  await page.keyboard.press('Alt+n')
  await page.keyboard.press('Alt+4')
  await expect(page).toHaveURL(/#agents$/)
  await expect(importDialog(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(importDialog(page)).toBeHidden()
  await expect(newButton).toHaveAttribute('aria-keyshortcuts', 'Alt+N')
})

test('a delete stays neutral until pointed at and still asks first', async ({ page, request }) => {
  const slug = `e2e/${unique('shortcut-delete')}`
  const created = await request.post('/api/repos', { data: { slug, path: paths.checkout, base_branch: 'main' } })
  expect(created.ok(), 'POST /api/repos').toBe(true)
  const repo = ((await created.json()) as Envelope<Repo>).data
  const repoExists = async () => (await apiData<Repo[]>(request, '/repos')).some((entry) => entry.id === repo.id)

  await page.goto('/#settings/repos')
  const row = page.getByRole('row', { name: new RegExp(slug) })
  const remove = row.getByRole('button', { name: 'Delete' })
  const colour = async () => remove.evaluate((element) => getComputedStyle(element).color)
  const edit = row.getByRole('button', { name: 'Edit' })
  await expect(remove).toHaveAttribute('data-variant', 'outline')
  expect(await colour()).toBe(await edit.evaluate((element) => getComputedStyle(element).color))
  await remove.hover()
  await expect.poll(colour).not.toBe(await edit.evaluate((element) => getComputedStyle(element).color))

  await remove.click()
  const confirm = page.getByRole('dialog', { name: 'Confirm' })
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(confirm).toBeHidden()
  expect(await repoExists()).toBe(true)

  await remove.click()
  await confirm.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(row).toBeHidden()
  await expect.poll(repoExists).toBe(false)
})
