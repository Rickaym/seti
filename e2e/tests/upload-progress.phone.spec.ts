import { expect, test, toasts } from './support/fixtures.js'
import { expectFitsPhone, expectTouchTarget } from './support/phone-layout.js'
import {
  attach,
  composerStatus,
  holdUploads,
  openAgent,
  PAST_STALL_MS,
  pdfOf,
  release,
  reportProgress,
  UPLOAD_URL,
} from './support/uploads.js'

const MB = 1024 * 1024

test('a phone shows progress on the chip, calls a quiet upload stalled, and Retry finishes it', async ({ page }) => {
  await page.clock.install()
  await holdUploads(page)
  await openAgent(page, 'Phone upload')
  const chip = await attach(page, 'quarterly-report-final.pdf', pdfOf(2.5 * MB))

  await reportProgress(page, 0, 0.4)
  await expect(chip).toContainText('40%')
  await expect(chip.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')
  await expect(page.getByRole('progressbar', { name: 'Uploading 1 file...' })).toHaveAttribute('aria-valuenow', '40')
  await expect(composerStatus(page)).toHaveText('Uploading 1 file...')
  await expectTouchTarget(chip.getByRole('button', { name: /^Drop / }), 'Drop', 'both')
  await expectFitsPhone(page, 'composer with an upload under way')

  await page.clock.runFor(PAST_STALL_MS)
  await expect(chip).toContainText('Stalled')
  await expect(composerStatus(page)).toHaveText('quarterly-report-final.pdf stalled. Retry or drop it to send.')
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  const retry = chip.getByRole('button', { name: /^Retry / })
  await expectTouchTarget(retry, 'Retry', 'both')
  await expectTouchTarget(chip.getByRole('button', { name: /^Drop / }), 'Drop', 'both')
  await expectFitsPhone(page, 'composer with a stalled upload')

  await retry.tap()
  await expect(chip).toContainText('0%')
  await release(page, 1)
  await expect(chip).toContainText('PDF, 2.5 MB')
  await expect(page.getByRole('progressbar')).toHaveCount(0)
  await expect(composerStatus(page)).toHaveText('')
  await expect(toasts(page)).toHaveCount(0)
})

test.describe('failures', () => {
  test.use({ allowedConsoleErrors: [/net::ERR_CONNECTION_RESET/] })

  test('a phone shows why an upload failed, retries it, and cancels one in flight', async ({ page }) => {
    await holdUploads(page)
    await page.route(UPLOAD_URL, async (route) => route.abort('connectionreset'))
    await openAgent(page, 'Phone upload failure')
    const chip = await attach(page, 'quarterly-report-final.pdf', pdfOf(4096))
    await release(page, 0)

    const reason = 'The connection to Seti dropped before the file arrived'
    await expect(chip).toContainText('Connection lost')
    await expect(composerStatus(page)).toContainText(`did not upload: ${reason}. Retry or drop it to send.`)
    const toast = toasts(page).filter({ hasText: 'quarterly-report-final.pdf did not upload' })
    await expect(toast).toContainText(reason)
    const retry = chip.getByRole('button', { name: /^Retry / })
    await expectTouchTarget(retry, 'Retry', 'both')
    await expectFitsPhone(page, 'composer with a failed upload', ['[data-sonner-toaster]'])

    await retry.tap()
    await expect(toast).toHaveCount(0)
    await reportProgress(page, 1, 0.6)
    await expect(chip).toContainText('60%')
    await chip.getByRole('button', { name: /^Drop / }).tap()
    await expect(page.getByRole('list', { name: 'Attachments' })).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: 'Reply' })).toHaveValue('')
    await expect(composerStatus(page)).toHaveText('')
  })
})
