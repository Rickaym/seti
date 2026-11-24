import { codexRegistry } from './support/codex-registry.js'
import { codexKey, codexOff } from './support/codex.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone, expectTouchTarget } from './support/phone-layout.js'

test('a phone turns Codex on, which installs it, and reaches Ready', async ({ page, request }) => {
  const registry = codexRegistry()
  await codexOff(request)
  try {
    await page.goto('/#settings/runtimes')
    const card = page.getByRole('main').getByRole('region', { name: 'Codex' })
    await expect(card.getByRole('status')).toHaveText('Off')
    await expectFitsPhone(page, 'Runtimes with Codex off')

    registry.mode = 'down'
    await card.getByRole('button', { name: 'Codex', exact: true }).tap()
    await expect(card.getByRole('status')).toHaveText('Failed')
    await expect(card).toContainText('Download failed')
    const retry = card.getByRole('button', { name: 'Retry' })
    await expectTouchTarget(retry)
    await expectFitsPhone(page, 'Runtimes with a failed install')

    registry.mode = 'hold'
    await retry.tap()
    await expect(card.getByRole('status')).toHaveText('Installing')
    await expectFitsPhone(page, 'Runtimes while Codex installs')
    registry.release()
    await expect(card.getByRole('status')).toHaveText('No key')
    await expectFitsPhone(page, 'Runtimes with no OpenAI key')

    await codexKey(request)
    await page.reload()
    await expect(card.getByRole('status')).toHaveText('Ready')
    await card.getByRole('button', { name: /Advanced/ }).tap()
    await expect(card.getByRole('textbox', { name: 'Own program' })).toBeVisible()
    await expectFitsPhone(page, 'Runtimes with Codex ready and Advanced open')
  } finally {
    await codexOff(request)
  }
})
