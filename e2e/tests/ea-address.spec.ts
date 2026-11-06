import type { AuditPage, EaSettings } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'

const PLAIN = { wake_enabled: false, wake_phrase: 'Hey Seti', keep_awake_seconds: 30, form_of_address: '' }

test.afterEach(async ({ request }) => {
  await request.put('/api/ea/settings', { data: PLAIN })
})

test('the EA uses no title until the user picks one, and a wake word change keeps it', async ({ page, request }) => {
  expect((await request.put('/api/ea/settings', { data: PLAIN })).ok()).toBe(true)
  await page.goto('/#settings/ea')
  const main = page.getByRole('main')
  const field = main.getByRole('region', { name: 'Manner' }).getByRole('textbox', { name: 'Address as' })
  await expect(field).toHaveValue('')
  await expect(field).toHaveAttribute('placeholder', 'No title')
  await field.hover()
  await expect(page.getByRole('tooltip')).toContainText('leave it empty for none')

  await field.fill('sir <b>')
  await field.press('Enter')
  await expect(main.getByRole('region', { name: 'Manner' }).getByRole('alert')).toContainText('Use letters')
  await field.fill("ma'am")
  await field.press('Enter')
  await expect.poll(async () => (await apiData<EaSettings>(request, '/ea/settings')).form_of_address).toBe("ma'am")
  const audit = await apiData<AuditPage>(request, '/audit?kind=ea.settings_changed&limit=1')
  expect(audit.events[0]).toMatchObject({ summary: `EA addresses the user as "ma'am"` })

  const wake = main.getByRole('group', { name: 'Wake word' })
  await wake.getByRole('button', { name: 'Wake word' }).click()
  await expect
    .poll(async () => apiData<EaSettings>(request, '/ea/settings'))
    .toMatchObject({ wake_enabled: true, form_of_address: "ma'am" })
  await expect(field).toHaveValue("ma'am")

  await field.fill('')
  await field.blur()
  await expect.poll(async () => (await apiData<EaSettings>(request, '/ea/settings')).form_of_address).toBe('')
  await expect
    .poll(async () => (await apiData<AuditPage>(request, '/audit?kind=ea.settings_changed&limit=1')).events[0])
    .toMatchObject({ summary: 'EA addresses the user with no title' })
})
