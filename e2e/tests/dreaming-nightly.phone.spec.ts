import type { DreamSettings } from '@seti/shared'
import { dreams, idleAgent } from './support/dreams.js'
import { apiData, expect, test } from './support/fixtures.js'
import { expectFitsPhone, expectTouchTarget } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV, timezoneId: 'Europe/Berlin' })

test.afterEach(async ({ request }) => {
  await request.put('/api/dreams/settings', { data: { enabled: false } })
})

test('Dreaming is configured in full on a phone, on a night the clocks change', async ({ page, request }) => {
  await page.clock.setFixedTime(new Date('2026-03-28T20:00:00Z'))
  await page.goto('/#settings/agents')
  const card = page.getByRole('region', { name: 'Dreaming' })
  await expect(card.getByRole('combobox', { name: 'Zone' })).toHaveValue('Europe/Berlin')
  const toggle = card.getByRole('button', { name: 'Dreaming' })
  await toggle.scrollIntoViewIfNeeded()
  await expectTouchTarget(toggle)
  await toggle.tap()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await card.getByLabel('Window start').fill('02:30')
  await card.getByLabel('Window end').fill('04:30')
  await card.getByLabel('Model').selectOption('claude-haiku-5-5')
  await card.getByLabel('Per dream').fill('0.50')
  await card.getByLabel('Per night').fill('3')
  await card.getByLabel('At once').selectOption('2')
  await expectFitsPhone(page, 'the Dreaming card')
  await card.getByRole('button', { name: 'Save' }).tap()
  await expect(card.getByRole('button', { name: 'Save' })).toBeDisabled()
  expect(await apiData<DreamSettings>(request, '/dreams/settings')).toMatchObject({
    enabled: true,
    zone: 'Europe/Berlin',
    window_start: '02:30',
    window_end: '04:30',
    model: 'claude-haiku-5-5',
    dream_budget_usd: 0.5,
    night_budget_usd: 3,
    at_once: 2,
  })

  const id = await idleAgent(request)
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'Agent settings' }).tap()
  const nightly = dreams(page).getByRole('button', { name: 'Nightly' })
  await nightly.scrollIntoViewIfNeeded()
  await expectTouchTarget(nightly)
  await nightly.tap()
  await expect(nightly).toHaveAttribute('aria-pressed', 'false')
  await expectFitsPhone(page, 'the dream actions with the nightly switch')
})
