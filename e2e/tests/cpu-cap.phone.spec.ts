import type { CpuCapSettings, TaskCpuCap } from '@seti/shared'
import { showSection, settingsDialog } from './support/agent-settings.js'
import { apiData, expect, test, toasts } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV, startShellAgent } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('the CPU cap fits a phone in Settings and in an agent settings sheet', async ({ page, request }) => {
  const { defaults } = await apiData<CpuCapSettings>(request, '/resources/cpu')
  await page.goto('/#settings/resources')
  const card = page.getByRole('main').getByRole('region', { name: 'CPU cap' })
  const field = card.getByRole('spinbutton', { name: 'Cores' })
  await expect(field).toBeVisible()
  await expectFitsPhone(page, 'resources page with the CPU cap')
  await field.fill('1.5')
  await card.getByRole('button', { name: 'Save' }).tap()
  await expect(toasts(page).filter({ hasText: 'CPU cap saved' })).toBeVisible()
  expect((await apiData<CpuCapSettings>(request, '/resources/cpu')).cap).toEqual({ quota_percent: 150 })
  await card.getByRole('button', { name: 'CPU cap', exact: true }).tap()
  await expect(field).toHaveCount(0)
  await expectFitsPhone(page, 'resources page with the CPU cap off')
  await card.getByRole('button', { name: 'Defaults' }).tap()
  await card.getByRole('button', { name: 'Save' }).tap()
  await expect.poll(async () => (await apiData<CpuCapSettings>(request, '/resources/cpu')).cap).toEqual(defaults)

  const id = await startShellAgent(request)
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'Agent settings' }).first().tap()
  const session = await showSection(settingsDialog(page), 'Session')
  await expect(session.locator('dt', { hasText: 'CPU' })).toBeVisible()
  await session.getByRole('button', { name: 'Change CPU cap' }).tap()
  await session.getByRole('spinbutton', { name: 'Cores' }).fill('1')
  await expectFitsPhone(page, 'agent CPU cap editor')
  await session.getByRole('button', { name: 'Save' }).tap()
  await expect(session).toContainText('1 core (own)')
  expect((await apiData<TaskCpuCap>(request, `/tasks/${id}/cpu`)).override).toEqual({ quota_percent: 100 })
  await expectFitsPhone(page, 'agent settings with its own CPU cap')
})
