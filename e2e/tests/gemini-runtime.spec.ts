import type { Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { geminiRegistry, PINNED_GEMINI } from './support/gemini-registry.js'
import { geminiKey, geminiOff } from './support/gemini.js'

const card = (page: Page) => page.getByRole('main').getByRole('region', { name: 'Gemini' })

test('turning Gemini on installs Gemini CLI, shows a failure with Retry, and reads Ready with a key', async ({
  page,
  request,
}) => {
  const registry = geminiRegistry()
  await geminiOff(request)
  try {
    await page.goto('/#settings/runtimes')
    await expect(card(page).getByRole('status')).toHaveText('Off')
    const toggle = card(page).getByRole('button', { name: 'Gemini', exact: true })
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(card(page).getByText('Gemini API key')).toHaveCount(0)
    await expect(card(page)).toContainText('runs a few read-only commands, such as cat, ls and grep, without asking')

    registry.mode = 'corrupt'
    await toggle.click()
    await expect(card(page).getByRole('status')).toHaveText('Failed')
    await expect(card(page)).toContainText('Checksum mismatch')

    registry.mode = 'hold'
    await card(page).getByRole('button', { name: 'Retry' }).click()
    await expect(card(page).getByRole('status')).toHaveText('Installing')
    await expect(card(page)).toContainText(`Gemini CLI ${PINNED_GEMINI} from the npm registry`)
    registry.release()
    await expect(card(page).getByRole('status')).toHaveText('No key')
    await expect(card(page)).toContainText('add your Gemini API key in Connections')

    await geminiKey(request)
    await page.reload()
    await expect(card(page).getByRole('status')).toHaveText('Ready')
    await expect(card(page).getByRole('button', { name: 'Rules' })).toHaveAttribute('aria-pressed', 'true')
    const model = card(page).getByRole('combobox', { name: 'Default model' })
    await expect(model.locator('option', { hasText: 'gemini-4-carbon (unproven)' })).toHaveCount(1)
    await model.selectOption('gemini-3.8-flash')
    await expect(model).toHaveValue('gemini-3.8-flash')
    await expect(card(page)).toContainText(/prices as of \d{4}-\d{2}-\d{2}/)

    await page.goto('/#agents/new')
    await page.reload()
    const picker = page.getByRole('main').getByRole('combobox', { name: 'Model' })
    await expect(picker.locator('optgroup[label="Gemini"]')).toHaveCount(1)
    await picker.selectOption({ label: 'gemini-4-neon (unproven)' })
    await expect(page.getByRole('main')).toContainText('Gemini: sandboxed; cat, ls, grep run unasked.')
  } finally {
    await geminiOff(request)
  }
})
