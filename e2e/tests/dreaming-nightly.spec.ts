import type { DreamSettings } from '@seti/shared'
import { dreams, idleAgent } from './support/dreams.js'
import { apiData, expect, test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV, timezoneId: 'Europe/Istanbul' })

test.afterEach(async ({ request }) => {
  await request.put('/api/dreams/settings', { data: { enabled: false } })
})

test('Dreaming turns on in the browser zone, keeps its window, and an agent can be left out', async ({
  page,
  request,
}) => {
  await page.clock.setFixedTime(new Date('2026-11-24T19:00:00Z'))
  await page.goto('/#settings/agents')
  const card = page.getByRole('region', { name: 'Dreaming' })
  await expect(card.getByRole('combobox', { name: 'Zone' })).toHaveValue('Europe/Istanbul')
  await card.getByRole('button', { name: 'Dreaming' }).click()
  await expect(card.getByRole('button', { name: 'Dreaming' })).toHaveAttribute('aria-pressed', 'true')
  await card.getByLabel('Window start').fill('23:30')
  await card.getByLabel('Window end').fill('03:00')
  await card.getByRole('button', { name: 'Save' }).click()
  await expect
    .poll(async () => apiData<DreamSettings>(request, '/dreams/settings'))
    .toMatchObject({
      enabled: true,
      zone: 'Europe/Istanbul',
      window_start: '23:30',
      window_end: '03:00',
    })

  const id = await idleAgent(request)
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'Agent settings' }).click()
  const nightly = dreams(page).getByRole('button', { name: 'Nightly' })
  await expect(nightly).toHaveAttribute('aria-pressed', 'true')
  await nightly.click()
  await expect(nightly).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(async () => (await apiData<{ tasks: string[] }>(request, '/dreams/off')).tasks).toContain(id)
})
