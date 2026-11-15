import type { EaSettings } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

const PLAIN = { wake_enabled: false, wake_phrase: 'Hey Seti', keep_awake_seconds: 30, language: 'en' }

test.afterEach(async ({ request }) => {
  await request.put('/api/ea/settings', { data: PLAIN })
})

test('the language picker fits a phone and saves a choice', async ({ page, request }) => {
  expect((await request.put('/api/ea/settings', { data: PLAIN })).ok()).toBe(true)
  await page.goto('/#settings/ea')
  const card = page.getByRole('main').getByRole('region', { name: 'Manner' })
  await expect(card).toContainText('a change applies to a live call at once.')
  const select = card.getByRole('combobox', { name: 'Language' })
  await select.scrollIntoViewIfNeeded()
  await expect(select).toHaveValue('en')
  await expectFitsPhone(page, 'EA page with the language picker')
  await select.selectOption({ label: 'Japanese' })
  await expect.poll(async () => (await apiData<EaSettings>(request, '/ea/settings')).language).toBe('ja')
  await page.reload()
  await expect(card.getByRole('combobox', { name: 'Language' })).toHaveValue('ja')
  await expectFitsPhone(page, 'EA page with a language set')
})
