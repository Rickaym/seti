import type { EaSettings } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

const PLAIN = { wake_enabled: false, wake_phrase: 'Hey Seti', keep_awake_seconds: 30, form_of_address: '' }

test.afterEach(async ({ request }) => {
  await request.put('/api/ea/settings', { data: PLAIN })
})

test('the form of address fits a phone and saves from the keyboard', async ({ page, request }) => {
  expect((await request.put('/api/ea/settings', { data: PLAIN })).ok()).toBe(true)
  await page.goto('/#settings/ea')
  const card = page.getByRole('main').getByRole('region', { name: 'Manner' })
  await expect(card).toContainText('Empty means none.')
  const field = card.getByRole('textbox', { name: 'Address as' })
  await field.scrollIntoViewIfNeeded()
  await expectFitsPhone(page, 'EA page with the form of address')
  await field.tap()
  await field.fill('Dr. Okafor')
  await field.press('Enter')
  await expect.poll(async () => (await apiData<EaSettings>(request, '/ea/settings')).form_of_address).toBe('Dr. Okafor')
  await page.reload()
  await expect(card.getByRole('textbox', { name: 'Address as' })).toHaveValue('Dr. Okafor')
  await expectFitsPhone(page, 'EA page with a form of address set')
})
