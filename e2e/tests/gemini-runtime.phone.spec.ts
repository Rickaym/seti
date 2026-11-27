import { expect, test } from './support/fixtures.js'
import { geminiRegistry } from './support/gemini-registry.js'
import { geminiKey, geminiOff } from './support/gemini.js'
import { expectFitsPhone, expectTouchTarget } from './support/phone-layout.js'

test('a phone turns Gemini on, which installs Gemini CLI, and reaches Ready', async ({ page, request }) => {
  const registry = geminiRegistry()
  await geminiOff(request)
  try {
    await page.goto('/#settings/runtimes')
    const card = page.getByRole('main').getByRole('region', { name: 'Gemini' })
    await expect(card.getByRole('status')).toHaveText('Off')
    await expectFitsPhone(page, 'Runtimes with Gemini off')

    registry.mode = 'down'
    const toggle = card.getByRole('button', { name: 'Gemini', exact: true })
    await expectTouchTarget(toggle)
    await toggle.tap()
    await expect(card.getByRole('status')).toHaveText('Failed')
    await expect(card).toContainText('Download failed')
    const retry = card.getByRole('button', { name: 'Retry' })
    await expectTouchTarget(retry)
    await expectFitsPhone(page, 'Runtimes with a failed Gemini install')

    registry.release()
    await retry.tap()
    await expect(card.getByRole('status')).toHaveText('No key')
    await geminiKey(request)
    await page.reload()
    await expect(card.getByRole('status')).toHaveText('Ready')
    await expect(card.getByRole('combobox', { name: 'Default model' })).toBeVisible()
    await expectFitsPhone(page, 'Runtimes with Gemini ready')
  } finally {
    await geminiOff(request)
  }
})
