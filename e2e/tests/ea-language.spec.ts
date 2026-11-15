import { EA_LANGUAGES, type AuditPage, type EaSettings } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'

const PLAIN = { wake_enabled: false, wake_phrase: 'Hey Seti', keep_awake_seconds: 30, language: 'en' }

test.afterEach(async ({ request }) => {
  await request.put('/api/ea/settings', { data: PLAIN })
})

test('the EA speaks English until the user picks a language, and other settings keep it', async ({ page, request }) => {
  expect((await request.put('/api/ea/settings', { data: PLAIN })).ok()).toBe(true)
  await page.goto('/#settings/ea')
  const main = page.getByRole('main')
  const card = main.getByRole('region', { name: 'Manner' })
  const select = card.getByRole('combobox', { name: 'Language' })
  await expect(select).toHaveValue('en')
  await expect(select.getByRole('option')).toHaveText(EA_LANGUAGES.map((language) => language.name))
  await expect(card).toContainText('The wake phrase stays in English words.')
  await select.hover()
  await expect(page.getByRole('tooltip')).toContainText('Multilingual follows the one you last used')

  await select.selectOption({ label: 'Turkish' })
  await expect.poll(async () => (await apiData<EaSettings>(request, '/ea/settings')).language).toBe('tr')
  await expect(select).toHaveValue('tr')
  const audit = await apiData<AuditPage>(request, '/audit?kind=ea.settings_changed&limit=1')
  expect(audit.events[0]).toMatchObject({ summary: 'EA language set to Turkish' })

  const wake = main.getByRole('group', { name: 'Wake word' })
  await wake.getByRole('button', { name: 'Wake word' }).click()
  await expect
    .poll(async () => apiData<EaSettings>(request, '/ea/settings'))
    .toMatchObject({ wake_enabled: true, language: 'tr' })
  await expect(select).toHaveValue('tr')

  await select.selectOption({ label: 'Multilingual' })
  await expect
    .poll(async () => (await apiData<AuditPage>(request, '/audit?kind=ea.settings_changed&limit=1')).events[0])
    .toMatchObject({ summary: 'EA language set to Multilingual' })
  await page.reload()
  await expect(card.getByRole('combobox', { name: 'Language' })).toHaveValue('multi')
})

test('a language outside the list is refused', async ({ request }) => {
  const refused = await request.put('/api/ea/settings', { data: { ...PLAIN, language: 'Klingon' } })
  expect(refused.status()).toBe(400)
  expect((await apiData<EaSettings>(request, '/ea/settings')).language).toBe('en')
})
