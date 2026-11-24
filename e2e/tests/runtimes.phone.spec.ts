import { codexKey, codexOff, codexStandIn, PINNED_CODEX } from './support/codex.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test('a phone sets Codex up from Settings, Runtimes', async ({ page, request }) => {
  await codexOff(request)
  try {
    await page.goto('/#settings/runtimes')
    const card = page.getByRole('main').getByRole('region', { name: 'Codex' })
    await expect(card.getByRole('status')).toHaveText('Off')
    await expectFitsPhone(page, 'Runtimes with Codex off')

    await card.getByRole('button', { name: 'Codex', exact: true }).tap()
    await expect(card.getByRole('status')).toHaveText('Not set up')
    await card.getByRole('textbox', { name: 'Program' }).fill(codexStandIn(PINNED_CODEX))
    await card.getByRole('button', { name: 'Save' }).tap()
    await expect(card.getByRole('status')).toHaveText('No key')
    await expectFitsPhone(page, 'Runtimes with no OpenAI key')

    await codexKey(request)
    await page.reload()
    await expect(card.getByRole('status')).toHaveText('Ready')
    await expectFitsPhone(page, 'Runtimes with Codex ready')
  } finally {
    await codexOff(request)
  }
})
