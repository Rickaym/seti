import { expect, test, unique } from './support/fixtures.js'
import { LEDGER, ledgerReply, seedLedgerReply } from './support/ledger.js'
import { expectFitsPhone, settled } from './support/phone-layout.js'

test('on a phone the checked quote and the unread link show in the reply and its sheet', async ({ page }) => {
  const id = await seedLedgerReply(unique('Phone ledger marks'))
  await page.goto(`/#agents/${id}`)
  const reply = ledgerReply(page)
  await expect(reply.getByTestId('quote-source').getByTestId('quote-verified')).toBeVisible()

  const sources = reply.getByRole('region', { name: 'Sources' })
  await sources.getByRole('button', { name: '2 sources' }).tap()
  await expect(sources.locator('[data-source="2"]').getByTestId('source-not-read')).toBeVisible()
  await expectFitsPhone(page, 'a reply with a checked quote and an unread link')
  await sources.scrollIntoViewIfNeeded()
  await page.screenshot({ path: test.info().outputPath('ledger-phone-light.png') })

  await reply.locator('[data-reference="1"]').first().tap()
  const sheet = page.getByTestId('reference-sheet')
  await expect(sheet.getByTestId('source-facts')).toContainText(`${LEDGER.place}, `)
  await expect(sheet.getByTestId('quote-verified')).toBeVisible()
  await page.emulateMedia({ colorScheme: 'dark' })
  await settled(page)
  await page.screenshot({ path: test.info().outputPath('ledger-sheet-phone-dark.png') })
  await page.emulateMedia({ colorScheme: 'light' })
})
