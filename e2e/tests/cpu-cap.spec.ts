import { coresLabel, type AgentProcesses, type CpuCapSettings, type TaskCpuCap } from '@seti/shared'
import { openAgentSettings } from './support/agent-settings.js'
import { apiData, expect, test, toasts } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV, startShellAgent } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('the resources page sets the CPU cap of every agent, turns it off and goes back to the default', async ({
  page,
  request,
}) => {
  const { defaults, max_percent: max } = await apiData<CpuCapSettings>(request, '/resources/cpu')
  const cores = String((defaults.quota_percent ?? 0) / 100)
  await page.goto('/#settings/resources')
  const card = page.getByRole('region', { name: 'CPU cap' })
  await expect(card).toContainText(`Default: ${coresLabel(defaults.quota_percent ?? 0)}`)
  const toggle = card.getByRole('button', { name: 'CPU cap', exact: true })
  const field = card.getByRole('spinbutton', { name: 'Cores' })
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(field).toHaveValue(cores)
  await expect(card).toContainText(`of ${coresLabel(max)}`)

  await field.fill('0.25')
  await card.getByRole('button', { name: 'Save' }).click()
  await expect(toasts(page).filter({ hasText: 'at least half a core' })).toBeVisible()
  await field.fill(String(max / 100 + 1))
  await card.getByRole('button', { name: 'Save' }).click()
  await expect(toasts(page).filter({ hasText: 'the cap cannot be above that' })).toBeVisible()

  await field.fill('0.5')
  await card.getByRole('button', { name: 'Save' }).click()
  await expect(toasts(page).filter({ hasText: 'CPU cap saved' })).toBeVisible()
  expect((await apiData<CpuCapSettings>(request, '/resources/cpu')).cap).toEqual({ quota_percent: 50 })

  await toggle.click()
  await expect(field).toHaveCount(0)
  await expect(card).toContainText('No cap: the agent may use every core')
  await card.getByRole('button', { name: 'Save' }).click()
  await expect
    .poll(async () => (await apiData<CpuCapSettings>(request, '/resources/cpu')).cap)
    .toEqual({ quota_percent: null })

  await card.getByRole('button', { name: 'Defaults' }).click()
  await expect(field).toHaveValue(cores)
  await card.getByRole('button', { name: 'Save' }).click()
  await expect.poll(async () => (await apiData<CpuCapSettings>(request, '/resources/cpu')).cap).toEqual(defaults)
})

test('an agent gets a CPU cap of its own from its settings, at once, and the default back', async ({
  page,
  request,
}) => {
  const { enforced, defaults } = await apiData<CpuCapSettings>(request, '/resources/cpu')
  const label = coresLabel(defaults.quota_percent ?? 0)
  const id = await startShellAgent(request)
  await page.goto(`/#agents/${id}`)
  await openAgentSettings(page, 'Session')
  const details = page.getByRole('dialog').getByLabel('Agent details')
  await expect(details).toContainText(enforced ? `${label} (default)` : `${label} (default), not enforced here`)

  await details.getByRole('button', { name: 'Change CPU cap' }).click()
  await details.getByRole('spinbutton', { name: 'Cores' }).fill('2')
  await details.getByRole('button', { name: 'Save' }).click()
  await expect(details).toContainText('2 cores (own)')
  expect((await apiData<TaskCpuCap>(request, `/tasks/${id}/cpu`)).override).toEqual({ quota_percent: 200 })
  if (enforced) {
    await expect
      .poll(async () => (await apiData<AgentProcesses>(request, `/tasks/${id}/processes`)).cpu[0]?.quota_percent)
      .toBe(200)
  }

  await details.getByRole('button', { name: 'Change CPU cap' }).click()
  await details.getByRole('button', { name: 'Default' }).click()
  await expect(details).toContainText(`${label} (default)`)
  expect((await apiData<TaskCpuCap>(request, `/tasks/${id}/cpu`)).override).toBeNull()
})

test('the processes panel shows what the agent uses against its CPU cap', async ({ page, request }) => {
  const { enforced, defaults } = await apiData<CpuCapSettings>(request, '/resources/cpu')
  const id = await startShellAgent(request)
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: /^Processes/ }).click()
  const panel = page.getByRole('dialog', { name: 'Processes' })
  await expect(panel.getByRole('region', { name: 'Background shells' }).getByTestId('shell-row')).toHaveCount(1)
  const cpu = panel.getByRole('region', { name: 'CPU' })
  if (!enforced) {
    await expect(cpu).toHaveCount(0)
    return
  }
  const cap = coresLabel(defaults.quota_percent ?? 0)
  await expect(cpu.getByRole('meter', { name: new RegExp(`^Agent CPU: .+ of ${cap}$`) })).toBeVisible()
  const view = await apiData<AgentProcesses>(request, `/tasks/${id}/processes`)
  expect(view.cpu).toEqual([
    expect.objectContaining({ kind: 'agent', quota_percent: defaults.quota_percent, weight: 50 }),
  ])
})
