import type { AgentProcesses, MemoryCapSettings, TaskMemoryCap } from '@seti/shared'
import { openAgentSettings } from './support/agent-settings.js'
import { apiData, expect, test, toasts } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV, startShellAgent } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const GIB = 1024 ** 3

test('the resources page sets the memory cap of every agent and goes back to the defaults', async ({
  page,
  request,
}) => {
  await page.goto('/#settings/resources')
  const card = page.getByRole('region', { name: 'Memory cap' })
  await expect(card).toContainText('Defaults: 6 GB RAM, 1 GB swap')
  const cap = card.getByRole('spinbutton', { name: 'RAM cap' })
  const throttle = card.getByRole('spinbutton', { name: 'Soft cap' })
  await expect(cap).toHaveValue('6')
  await expect(card.getByRole('spinbutton', { name: 'Swap cap' })).toHaveValue('1')
  await expect(throttle).toHaveCount(0)

  await card.getByRole('button', { name: 'Soft cap' }).click()
  await expect(throttle).toHaveValue('4')
  await throttle.fill('9')
  await card.getByRole('button', { name: 'Save' }).click()
  await expect(toasts(page).filter({ hasText: 'cannot be above the RAM cap' })).toBeVisible()

  await cap.fill('10')
  await card.getByRole('button', { name: 'Save' }).click()
  await expect(toasts(page).filter({ hasText: 'Memory cap saved' })).toBeVisible()
  const saved = await apiData<MemoryCapSettings>(request, '/resources/memory')
  expect(saved.cap).toEqual({ high_mb: 9216, max_mb: 10240, swap_max_mb: 1024 })

  await card.getByRole('button', { name: 'Defaults' }).click()
  await expect(cap).toHaveValue('6')
  await expect(throttle).toHaveCount(0)
  await card.getByRole('button', { name: 'Save' }).click()
  await expect
    .poll(async () => (await apiData<MemoryCapSettings>(request, '/resources/memory')).cap)
    .toEqual(saved.defaults)
})

test('an agent gets a memory cap of its own from its settings, at once, and the default back', async ({
  page,
  request,
}) => {
  const { enforced } = await apiData<MemoryCapSettings>(request, '/resources/memory')
  const id = await startShellAgent(request)
  await page.goto(`/#agents/${id}`)
  await openAgentSettings(page, 'Session')
  const details = page.getByRole('dialog').getByLabel('Agent details')
  await expect(details).toContainText(enforced ? '6 GB (default)' : '6 GB (default), not enforced here')

  await details.getByRole('button', { name: 'Change memory cap' }).click()
  await details.getByRole('spinbutton', { name: 'RAM cap' }).fill('2')
  await details.getByRole('button', { name: 'Save' }).click()
  await expect(details).toContainText('2 GB (own)')
  const own = await apiData<TaskMemoryCap>(request, `/tasks/${id}/memory`)
  expect(own.override).toEqual({ high_mb: 2048, max_mb: 2048, swap_max_mb: 1024 })
  if (enforced) {
    await expect
      .poll(async () => (await apiData<AgentProcesses>(request, `/tasks/${id}/processes`)).memory[0]?.max_bytes)
      .toBe(2 * GIB)
  }

  await details.getByRole('button', { name: 'Change memory cap' }).click()
  await details.getByRole('button', { name: 'Default' }).click()
  await expect(details).toContainText('6 GB (default)')
  expect((await apiData<TaskMemoryCap>(request, `/tasks/${id}/memory`)).override).toBeNull()
})

test('the processes panel shows what the agent uses against its memory cap', async ({ page, request }) => {
  const { enforced } = await apiData<MemoryCapSettings>(request, '/resources/memory')
  const id = await startShellAgent(request)
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: /^Processes/ }).click()
  const panel = page.getByRole('dialog', { name: 'Processes' })
  await expect(panel.getByRole('region', { name: 'Background shells' }).getByTestId('shell-row')).toHaveCount(1)
  const memory = panel.getByRole('region', { name: 'Memory' })
  if (!enforced) {
    await expect(memory).toHaveCount(0)
    return
  }
  await expect(memory.getByRole('meter', { name: /^Agent: .+ of its 6\.0 GB cap$/ })).toBeVisible()
  const view = await apiData<AgentProcesses>(request, `/tasks/${id}/processes`)
  expect(view.memory).toEqual([
    expect.objectContaining({ kind: 'agent', max_bytes: 6 * GIB, high_bytes: 6 * GIB, oom_kills: 0 }),
  ])
  expect(view.memory[0]?.current_bytes).toBeGreaterThan(0)
})
