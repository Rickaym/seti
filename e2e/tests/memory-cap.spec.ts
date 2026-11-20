import type { APIRequestContext } from '@playwright/test'
import type { AgentProcesses, MemoryCapSettings, TaskMemoryCap } from '@seti/shared'
import { openAgentSettings } from './support/agent-settings.js'
import { apiData, expect, test, toasts } from './support/fixtures.js'
import { HOSTS, expectExplanationWraps, expectWholeValue, memoryCard, onHost } from './support/memory-cap.js'
import { FAKE_CLAUDE_ENV, startShellAgent } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const GIB = 1024 ** 3

/** The default cap in GB, which follows the memory of the host the suite runs on. */
const defaultGb = async (request: APIRequestContext) =>
  (await apiData<MemoryCapSettings>(request, '/resources/memory')).defaults.max_mb / 1024

test('the resources page sets the memory cap of every agent and goes back to the defaults', async ({
  page,
  request,
}) => {
  const gb = await defaultGb(request)
  await page.goto('/#settings/resources')
  const card = page.getByRole('region', { name: 'Memory cap' })
  await expect(card).toContainText(`Defaults: ${String(gb)} GB RAM, 1 GB swap`)
  const cap = card.getByRole('spinbutton', { name: 'RAM cap' })
  const throttle = card.getByRole('spinbutton', { name: 'Soft cap' })
  await expect(cap).toHaveValue(String(gb))
  await expect(card.getByRole('spinbutton', { name: 'Swap cap' })).toHaveValue('1')
  await expect(throttle).toHaveCount(0)

  await card.getByRole('button', { name: 'Soft cap' }).click()
  await expectWholeValue(throttle, String(Math.floor((gb * 4) / 3) / 2))
  await throttle.fill(String(gb + 1))
  await card.getByRole('button', { name: 'Save' }).click()
  await expect(toasts(page).filter({ hasText: 'cannot be above the RAM cap' })).toBeVisible()

  await cap.fill(String(gb + 2))
  await card.getByRole('button', { name: 'Save' }).click()
  await expect(toasts(page).filter({ hasText: 'Memory cap saved' })).toBeVisible()
  const saved = await apiData<MemoryCapSettings>(request, '/resources/memory')
  expect(saved.cap).toEqual({ high_mb: (gb + 1) * 1024, max_mb: (gb + 2) * 1024, swap_max_mb: 1024 })

  await card.getByRole('button', { name: 'Defaults' }).click()
  await expect(cap).toHaveValue(String(gb))
  await expect(throttle).toHaveCount(0)
  await card.getByRole('button', { name: 'Save' }).click()
  await expect
    .poll(async () => (await apiData<MemoryCapSettings>(request, '/resources/memory')).cap)
    .toEqual(saved.defaults)
})

for (const host of HOSTS) {
  test(`the memory cap card keeps its description beside the fields and saves on ${host.name}`, async ({
    page,
    request,
  }) => {
    const { defaults } = await apiData<MemoryCapSettings>(request, '/resources/memory')
    await onHost(page, host.defaults)
    await page.goto('/#settings/resources')
    const card = memoryCard(page)
    const gb = String(host.defaults.max_mb / 1024)
    await expect(card).toContainText(`Defaults: ${gb} GB RAM, 1 GB swap`)
    await expectWholeValue(card.getByRole('spinbutton', { name: 'RAM cap' }), gb)
    await expect(card.getByRole('button', { name: 'Defaults' })).toBeDisabled()
    await expect(card.getByRole('button', { name: 'Save' })).toBeDisabled()

    await card.getByRole('button', { name: 'Soft cap' }).click()
    const soft = card.getByRole('spinbutton', { name: 'Soft cap' })
    await expectWholeValue(soft, host.softGb)
    await expectExplanationWraps(card)
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 900 })
      const described = await card.getByText(/^Each agent, with everything/).boundingBox()
      const whole = await card.boundingBox()
      expect(described?.width ?? 0, `description at ${String(width)} px`).toBeGreaterThan((whole?.width ?? 0) / 4)
      expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    }

    await expect(card.getByRole('button', { name: 'Defaults' })).toBeEnabled()
    await card.getByRole('button', { name: 'Save' }).click()
    await expect(toasts(page).filter({ hasText: 'Memory cap saved' })).toBeVisible()
    expect((await apiData<MemoryCapSettings>(request, '/resources/memory')).cap).toEqual({
      ...host.defaults,
      high_mb: Number(host.softGb) * 1024,
    })
    expect((await request.put('/api/resources/memory', { data: defaults })).ok()).toBe(true)
  })
}

test('an agent gets a memory cap of its own from its settings, at once, and the default back', async ({
  page,
  request,
}) => {
  const { enforced } = await apiData<MemoryCapSettings>(request, '/resources/memory')
  const byDefault = `${String(await defaultGb(request))} GB (default)`
  const id = await startShellAgent(request)
  await page.goto(`/#agents/${id}`)
  await openAgentSettings(page, 'Session')
  const details = page.getByRole('dialog').getByLabel('Agent details')
  await expect(details).toContainText(enforced ? byDefault : `${byDefault}, not enforced here`)

  await details.getByRole('button', { name: 'Change memory cap' }).click()
  await details.getByRole('button', { name: 'Soft cap' }).click()
  await expectExplanationWraps(details)
  await details.getByRole('button', { name: 'Soft cap' }).click()
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
  await expect(details).toContainText(byDefault)
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
  const gb = await defaultGb(request)
  await expect(
    memory.getByRole('meter', { name: new RegExp(`^Agent: .+ of its ${String(gb)}\\.0 GB cap$`) }),
  ).toBeVisible()
  const view = await apiData<AgentProcesses>(request, `/tasks/${id}/processes`)
  expect(view.memory).toEqual([
    expect.objectContaining({ kind: 'agent', max_bytes: gb * GIB, high_bytes: gb * GIB, oom_kills: 0 }),
  ])
  expect(view.memory[0]?.current_bytes).toBeGreaterThan(0)
})
