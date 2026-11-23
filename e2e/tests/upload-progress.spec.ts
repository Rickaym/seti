import { ATTACHMENT_FILE_MAX } from '@seti/shared'
import { expect, test, toasts } from './support/fixtures.js'
import {
  attach,
  composerStatus,
  holdUploads,
  openAgent,
  PAST_STALL_MS,
  pdfOf,
  release,
  reportProgress,
  stopped,
  UPLOAD_URL,
} from './support/uploads.js'

const MB = 1024 * 1024
/** Sonner's own toasts time out after four seconds; a failed upload's must outlast that. */
const PAST_A_NORMAL_TOAST_MS = 6000

test.describe('upload progress', () => {
  test('a file shows its bytes going up on its chip and for the draft, and can be cancelled', async ({ page }) => {
    await holdUploads(page)
    await openAgent(page, 'Upload progress')
    const chip = await attach(page, 'report.pdf', pdfOf(2.5 * MB))
    const reply = page.getByRole('combobox', { name: 'Reply' })
    await expect(reply).toHaveValue('[report.pdf]')
    await expect(chip).toContainText('0%')

    await reportProgress(page, 0, 0.4)
    await expect(chip).toContainText('40%')
    await expect(chip.getByRole('progressbar', { name: 'Uploading report.pdf' })).toHaveAttribute('aria-valuenow', '40')
    await expect(composerStatus(page)).toHaveText('Uploading 1 file...')
    const overall = page.getByRole('progressbar', { name: 'Uploading 1 file...' })
    await expect(overall).toHaveAttribute('aria-valuenow', '40')
    await expect(overall).toHaveAttribute('aria-valuetext', '40%, 1.0 MB of 2.5 MB sent')
    await reply.press('Enter')
    await expect(reply).toHaveValue('[report.pdf]')
    await chip.getByText('40%').hover()
    await expect(page.getByRole('tooltip')).toHaveText('1.0 MB of 2.5 MB sent')

    await page.getByRole('button', { name: 'Drop report.pdf' }).click()
    await expect(page.getByRole('list', { name: 'Attachments' })).toHaveCount(0)
    await expect(page.getByRole('progressbar')).toHaveCount(0)
    await expect(reply).toHaveValue('')
    await expect(composerStatus(page)).toHaveText('')
    await expect(toasts(page)).toHaveCount(0)
  })

  test('an upload that never gets an answer is called stalled, and Retry sends it again', async ({ page }) => {
    await page.clock.install()
    let hung = false
    await page.route(UPLOAD_URL, async (route) => {
      if (hung) {
        await route.continue()
      }
      hung = true
    })
    await openAgent(page, 'Upload stall')
    const chip = await attach(page, 'report.pdf', pdfOf(4096))
    await expect(composerStatus(page)).toHaveText('Uploading 1 file...')

    await page.clock.runFor(PAST_STALL_MS)
    await expect(chip).toContainText('Stalled')
    await expect(chip.getByRole('progressbar', { name: 'Stalled report.pdf' })).toBeVisible()
    await expect(composerStatus(page)).toHaveText('report.pdf stalled. Retry or drop it to send.')

    await chip.getByRole('button', { name: 'Retry report.pdf' }).click()
    await expect(chip).toContainText('PDF, 4.0 KB')
    await expect(chip.getByRole('button', { name: 'Retry report.pdf' })).toHaveCount(0)
    await expect(composerStatus(page)).toHaveText('')
    await expect(toasts(page)).toHaveCount(0)
  })

  test('a file over the limit is refused before it is sent, in a toast that stays', async ({ page }) => {
    await page.clock.install()
    let sent = 0
    page.on('request', (request) => {
      sent += UPLOAD_URL.test(request.url()) ? 1 : 0
    })
    await openAgent(page, 'Upload limit')
    const chip = await attach(page, 'big.bin', Buffer.alloc(ATTACHMENT_FILE_MAX + MB))

    const reason = 'big.bin is 26 MB and one file can be at most 25 MB'
    await expect(chip).toContainText('Too large')
    await expect(chip.getByRole('button', { name: 'Retry big.bin' })).toHaveCount(0)
    await expect(composerStatus(page)).toHaveText(`big.bin did not upload: ${reason}. Drop it to send.`)
    const toast = toasts(page).filter({ hasText: 'big.bin did not upload' })
    await expect(toast).toContainText(reason)
    await page.clock.fastForward(PAST_A_NORMAL_TOAST_MS)
    await expect(toast).toBeVisible()
    expect(sent).toBe(0)

    await page.getByRole('button', { name: 'Drop big.bin' }).click()
    await expect(toast).toHaveCount(0)
    await expect(composerStatus(page)).toHaveText('')
  })

  test.describe('refusals and lost connections', () => {
    test.use({ allowedHttpStatuses: [400, 413], allowedConsoleErrors: [/net::ERR_CONNECTION_RESET/] })

    test('a dropped connection fails with its reason, and Retry uploads the file', async ({ page }) => {
      await page.route(UPLOAD_URL, async (route) => route.abort('connectionreset'))
      await openAgent(page, 'Upload dropped')
      const chip = await attach(page, 'report.pdf', pdfOf(4096))

      const reason = 'The connection to Seti dropped before the file arrived'
      await expect(chip).toContainText('Connection lost')
      await expect(composerStatus(page)).toHaveText(`report.pdf did not upload: ${reason}. Retry or drop it to send.`)
      const toast = toasts(page).filter({ hasText: 'report.pdf did not upload' })
      await expect(toast).toContainText(reason)

      await page.unroute(UPLOAD_URL)
      await chip.getByRole('button', { name: 'Retry report.pdf' }).click()
      await expect(chip).toContainText('PDF, 4.0 KB')
      await expect(toast).toHaveCount(0)
      await expect(composerStatus(page)).toHaveText('')
    })

    test('a refusal names who refused: a proxy in front of Seti, or Seti with its reason', async ({ page }) => {
      await page.route(UPLOAD_URL, async (route) =>
        route.fulfill({ status: 413, contentType: 'text/html', body: '<h1>413 Request Entity Too Large</h1>' }),
      )
      await openAgent(page, 'Upload refused')
      const proxied = await attach(page, 'report.pdf', pdfOf(4096))
      await expect(proxied).toContainText('Too large')
      await expect(composerStatus(page)).toContainText(
        'A proxy in front of Seti refused the file as too large; Seti takes 25 MB a file',
      )
      await page.getByRole('button', { name: 'Drop report.pdf' }).click()

      await page.unroute(UPLOAD_URL)
      const empty = await attach(page, 'empty.txt', Buffer.alloc(0))
      await expect(empty).toContainText('Refused')
      await expect(composerStatus(page)).toHaveText('empty.txt did not upload: empty.txt is empty. Drop it to send.')
      await expect(toasts(page).filter({ hasText: 'empty.txt did not upload' })).toContainText('empty.txt is empty')
    })
  })

  test('an upload ends at its file details, and leaving the agent stops one in flight', async ({ page }) => {
    await holdUploads(page)
    await openAgent(page, 'Upload leave')
    const chip = await attach(page, 'report.pdf', pdfOf(4096))
    await reportProgress(page, 0, 0.5)
    await expect(chip).toContainText('50%')
    await release(page, 0)
    await expect(chip).toContainText('PDF, 4.0 KB')
    await expect(page.getByRole('progressbar')).toHaveCount(0)

    await attach(page, 'second.pdf', pdfOf(4096))
    await reportProgress(page, 1, 0.5)
    expect(await stopped(page)).toBe(0)
    await page.evaluate(() => {
      window.location.hash = '#context'
    })
    await expect.poll(async () => stopped(page)).toBe(1)
  })
})
