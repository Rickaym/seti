import { randomUUID } from 'node:crypto'
import { cleanUpWebhook, SENTRY_SECRET, sentryToggle } from './support/channel-sources.js'
import { expect, test } from './support/fixtures.js'

const name = `E2E GitHub ${randomUUID().slice(0, 6)}`

test.afterEach(async ({ request }) => {
  await cleanUpWebhook(request, name)
})

test('a GitHub webhook made in Settings takes a test delivery, its source always on', async ({ page }) => {
  await page.goto('/#settings/channels')
  const main = page.getByRole('main')
  await main.getByRole('button', { name: 'New', exact: true }).click()
  await page
    .getByRole('list', { name: 'Channel sources' })
    .getByRole('button', { name: /Webhook/ })
    .click()
  const dialog = page.getByRole('dialog', { name: 'New webhook' })
  await dialog.getByRole('textbox', { name: 'Name' }).fill(name)
  await dialog.getByRole('combobox', { name: 'Source' }).click()
  await page.getByRole('option', { name: 'GitHub' }).click()
  await expect(dialog).toContainText('Repository or organization webhooks')
  await dialog.getByRole('button', { name: 'Create' }).click()
  const secret = page.getByRole('dialog', { name })
  await expect(secret).toContainText('GitHub signs with X-Hub-Signature-256')
  await secret.getByRole('button', { name: 'Done' }).click()

  const card = main.getByRole('region', { name })
  await expect(card).toContainText('GitHub: signed with X-Hub-Signature-256')
  await expect(card).not.toContainText('Paused')
  await card.getByRole('button', { name: 'Test' }).click()
  await expect(page.getByText('Test event sent')).toBeVisible()
  await card.getByRole('button', { name: `${name} activity` }).click()
  await expect(card.getByRole('list', { name: `${name} events` })).toContainText(
    'Issue #1 opened: Test event from Seti',
  )
})

test('a Sentry webhook pauses while its mod is off and takes deliveries again once it is on', async ({
  page,
  request,
}) => {
  const made = await request.post('/api/channels', { data: { name, preset: 'sentry', secret: SENTRY_SECRET } })
  expect(made.ok(), await made.text()).toBe(true)
  await page.goto('/#settings/mods')
  await sentryToggle(page).click()
  await expect(sentryToggle(page)).toHaveAttribute('aria-pressed', 'false')

  await page.goto('/#settings/channels')
  const main = page.getByRole('main')
  const card = main.getByRole('region', { name })
  await expect(card).toContainText('The Sentry webhooks mod is off, so this webhook refuses every delivery.')
  await expect(card.getByRole('button', { name: 'Test' })).toBeDisabled()
  await main.getByRole('button', { name: 'New', exact: true }).click()
  await page
    .getByRole('list', { name: 'Channel sources' })
    .getByRole('button', { name: /Webhook/ })
    .click()
  await page.getByRole('dialog', { name: 'New webhook' }).getByRole('combobox', { name: 'Source' }).click()
  await expect(page.getByRole('option', { name: 'GitHub' })).toBeVisible()
  await expect(page.getByRole('option', { name: 'Sentry' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')

  await card.getByRole('link', { name: 'Mods' }).click()
  await sentryToggle(page).click()
  await expect(sentryToggle(page)).toHaveAttribute('aria-pressed', 'true')
  await page.goto('/#settings/channels')
  await expect(card).toContainText('Sentry: signed with Sentry-Hook-Signature')
  await expect(card).not.toContainText('Paused')
  await card.getByRole('button', { name: 'Test' }).click()
  await expect(page.getByText('Test event sent')).toBeVisible()
})
