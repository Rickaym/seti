import type { MemoryCapSettings } from '@seti/shared'
import { showSection, settingsDialog } from './support/agent-settings.js'
import { apiData, expect, test, toasts } from './support/fixtures.js'
import { HOSTS, expectExplanationWraps, expectWholeValue, memoryCard, onHost } from './support/memory-cap.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV, startShellAgent } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

for (const host of HOSTS) {
  test(`the memory cap fits a phone and saves on ${host.name}`, async ({ page, request }) => {
    const { defaults } = await apiData<MemoryCapSettings>(request, '/resources/memory')
    await onHost(page, host.defaults)
    await page.goto('/#settings/resources')
    const card = memoryCard(page)
    const gb = String(host.defaults.max_mb / 1024)
    await expectWholeValue(card.getByRole('spinbutton', { name: 'RAM cap' }), gb)
    await expectFitsPhone(page, 'resources page with the memory cap')

    await card.getByRole('button', { name: 'Soft cap' }).tap()
    await expectWholeValue(card.getByRole('spinbutton', { name: 'Soft cap' }), host.softGb)
    await expectExplanationWraps(card)
    await expectFitsPhone(page, 'memory cap with a soft cap')
    await card.getByRole('button', { name: 'Save' }).tap()
    await expect(toasts(page).filter({ hasText: 'Memory cap saved' })).toBeVisible()
    expect((await apiData<MemoryCapSettings>(request, '/resources/memory')).cap).toEqual({
      ...host.defaults,
      high_mb: Number(host.softGb) * 1024,
    })
    expect((await request.put('/api/resources/memory', { data: defaults })).ok()).toBe(true)
  })
}

test('an agent memory cap editor fits a phone', async ({ page, request }) => {
  const id = await startShellAgent(request)
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'Agent settings' }).first().tap()
  const session = await showSection(settingsDialog(page), 'Session')
  await session.getByRole('button', { name: 'Change memory cap' }).tap()
  await session.getByRole('button', { name: 'Soft cap' }).tap()
  await expect(session.getByRole('spinbutton', { name: 'Soft cap' })).toBeVisible()
  await expectExplanationWraps(session)
  await expectFitsPhone(page, 'agent memory cap editor with a soft cap')
})
