import { LOCAL_TOKENS } from './support/env.js'
import { expect, test } from './support/fixtures.js'
import {
  lastSendAudit,
  prompts,
  seedAgent,
  shareToSeti,
  shareWaits,
  underServiceWorker,
  type SharedFile,
} from './support/share-target.js'

test.use({ serviceWorkers: 'allow' })

const NOTES: SharedFile = { name: 'notes.txt', type: 'text/plain', body: 'meeting notes\n' }
const REPORT: SharedFile = { name: 'report.pdf', type: 'application/pdf', body: '%PDF-1.4\n%%EOF\n' }

test('a share lands on the Share page and goes to the picked agent with its files', async ({ page }) => {
  const id = await seedAgent('Share target agent')
  await seedAgent('Another agent')
  await underServiceWorker(page)
  await shareToSeti(page, {
    title: 'Release notes',
    text: 'Worth a read',
    url: 'https://example.com/notes',
    files: [NOTES, REPORT],
  })

  await expect(page.getByRole('heading', { name: 'Share' })).toBeVisible()
  const chips = page.getByRole('list', { name: 'Attachments' }).getByRole('listitem')
  await expect(chips).toHaveCount(2)
  await expect(chips.filter({ hasText: 'report.pdf' })).toContainText(/PDF, \d+ B/)
  const message = page.getByRole('combobox', { name: 'Message' })
  await expect(message).toHaveValue('Release notes\nWorth a read\nhttps://example.com/notes')

  await page.getByRole('button', { name: 'Drop notes.txt' }).click()
  await expect(chips).toHaveCount(1)
  await message.fill('Summarise this report')
  const send = page.getByRole('button', { name: 'Send', exact: true })
  await expect(send).toBeDisabled()
  await page.getByRole('searchbox', { name: 'Search agents' }).fill('share target')
  await expect(page.getByRole('radio')).toHaveCount(1)
  await page.getByRole('radio', { name: /Share target agent/ }).click()
  await expect(page.getByRole('status', { name: 'Composer status' })).toContainText('Goes to Share target agent.')
  await send.click()

  await page.waitForURL(new RegExp(`#agents/${id}$`))
  await expect.poll(async () => (await prompts(page, id)).length).toBe(2)
  const sent = (await prompts(page, id))[1]
  expect(sent?.attachments?.map((file) => file.name)).toEqual(['report.pdf'])
  expect(sent?.text).toContain('Summarise this report')
  await expect(page.getByText('Summarise this report')).toBeVisible()
  expect(await lastSendAudit(page, id)).toMatchObject({ via: 'share', files: ['report.pdf (15 B)'] })
  expect(await shareWaits(page)).toBe(false)
})

test('Cancel discards the share', async ({ page }) => {
  await underServiceWorker(page)
  await shareToSeti(page, { text: 'A passing thought', files: [NOTES] })
  await expect(page.getByRole('list', { name: 'Attachments' }).getByRole('listitem')).toHaveCount(1)
  expect(await shareWaits(page)).toBe(true)

  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.waitForURL(/#home$/)
  expect(await shareWaits(page)).toBe(false)
  await page.goto('/#share')
  await expect(page.getByRole('heading', { name: 'Nothing to share' })).toBeVisible()
})

test('New agent carries the files and the message to the start page', async ({ page }) => {
  await underServiceWorker(page)
  await shareToSeti(page, { text: 'Look into this crash', files: [REPORT] })
  const newAgent = page.getByRole('button', { name: 'New agent' })
  await expect(page.getByRole('list', { name: 'Attachments' })).toContainText(/PDF, \d+ B/)
  await newAgent.click()

  await page.waitForURL(/#agents\/new$/)
  await expect(page.getByRole('combobox', { name: 'Message' })).toHaveValue('Look into this crash')
  await expect(page.getByRole('list', { name: 'Attachments' }).getByRole('listitem')).toContainText('report.pdf')
  expect(await shareWaits(page)).toBe(false)
})

test.describe('signed out', () => {
  test.use({ extraHTTPHeaders: {}, allowedHttpStatuses: [401] })

  test('a share waits through sign-in, then shows', async ({ page }) => {
    await underServiceWorker(page)
    await expect(page.getByRole('heading', { name: 'Sign in to Seti' })).toBeVisible()
    await shareToSeti(page, { text: 'Shared before signing in', files: [NOTES] })

    await expect(page.getByRole('heading', { name: 'Sign in to Seti' })).toBeVisible()
    await page.getByLabel('Local token').fill(LOCAL_TOKENS.user)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByRole('heading', { name: 'Share' })).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Message' })).toHaveValue('Shared before signing in')
    await expect(page.getByRole('list', { name: 'Attachments' })).toContainText('notes.txt')
  })
})
