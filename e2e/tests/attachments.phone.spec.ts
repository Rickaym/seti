import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { MessagePage } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n', 'latin1')

test('the attach button opens the phone file picker and the file goes with the message', async ({ page }) => {
  const db = openSeedDb()
  const id = randomUUID()
  const at = new Date().toISOString()
  await db.idleTask(id, 'Phone attachments', paths.checkout, at)
  await db.message(id, 'prompt', JSON.stringify({ text: 'Seeded phone prompt.' }), at)
  await db.close()

  await page.goto(`/#agents/${id}`)
  await expect(page.getByText('Seeded phone prompt.')).toBeVisible()
  const attach = page.getByRole('button', { name: 'Attach', exact: true })
  expect((await attach.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40)

  const chooser = page.waitForEvent('filechooser')
  await attach.tap()
  const picker = await chooser
  expect(picker.isMultiple()).toBe(true)
  await picker.setFiles({ name: 'quarterly report final.pdf', mimeType: 'application/pdf', buffer: PDF })

  const chip = page.getByRole('list', { name: 'Attachments' }).getByRole('listitem')
  await expect(chip).toContainText(/PDF, \d+ B/)
  const reply = page.getByRole('combobox', { name: 'Reply' })
  await expect(reply).toHaveValue('[quarterly-report-final.pdf]')
  await expectFitsPhone(page, 'composer with an attachment')

  await reply.fill('Summarise [quarterly-report-final.pdf]')
  await page.getByRole('button', { name: 'Send', exact: true }).tap()
  await expect(chip).toHaveCount(0)
  const sent = async () =>
    (await apiData<MessagePage>(page.request, `/tasks/${id}/messages?limit=50`)).messages.flatMap((row) =>
      row.kind === 'prompt' ? [row.payload] : [],
    )
  await expect.poll(async () => (await sent()).length).toBe(2)
  const file = (await sent())[1]?.attachments?.[0]
  expect(file?.name).toBe('quarterly-report-final.pdf')
  expect(fs.readFileSync(path.join(paths.setiHome, 'workspace', id, 'uploads', file?.name ?? ''))).toEqual(PDF)
})
