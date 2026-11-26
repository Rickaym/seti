import { expect, test, unique } from './support/fixtures.js'
import { LEDGER, ledgerReply, READ_QUOTE, seedLedgerReply } from './support/ledger.js'
import { settled } from './support/phone-layout.js'

test('a quote the agent read shows a quiet check, and a link it never read says so', async ({ page }) => {
  const id = await seedLedgerReply(unique('Ledger marks'))
  await page.goto(`/#agents/${id}`)
  const reply = ledgerReply(page)

  const caption = reply.getByTestId('quote-source')
  await expect(caption).toContainText(LEDGER.place)
  await expect(caption).toContainText(LEDGER.day)
  await expect(caption.getByTestId('quote-verified')).toBeVisible()

  const sources = reply.getByRole('region', { name: 'Sources' })
  await expect(sources.locator('[data-source="1"]').getByTestId('quote-verified')).toBeVisible()
  await expect(sources.locator('[data-source="1"]').getByTestId('source-not-read')).toHaveCount(0)
  await expect(sources.locator('[data-source="2"]').getByTestId('source-not-read')).toHaveText('not read by this agent')
  await expect(sources.locator('[data-source="2"]').getByTestId('quote-verified')).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('ledger-light.png') })

  await reply.locator('[data-reference="1"]').first().hover()
  const card = page.getByTestId('reference-preview')
  await expect(card.getByTestId('source-facts')).toHaveText(LEDGER.day)
  await expect(card).toContainText(READ_QUOTE)
  await expect(card.getByTestId('quote-verified')).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('ledger-preview.png') })

  await page.mouse.move(0, 0)
  await expect(card).toBeHidden()
  await page.emulateMedia({ colorScheme: 'dark' })
  await settled(page)
  await page.screenshot({ path: test.info().outputPath('ledger-dark.png') })
  await page.emulateMedia({ colorScheme: 'light' })
})
