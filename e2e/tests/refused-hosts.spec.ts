import type { AuditPage } from '@seti/shared'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { seedRefusedHost } from './support/refused-hosts.js'

test('a refused host shows once with its count, and Allow host lets the agent reach it', async ({ page, request }) => {
  const { id, host } = await seedRefusedHost(unique('Fetcher'))
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  await expect(main.getByText(`Sandbox refused ${host} (41 times)`)).toBeVisible()
  await expect(page.getByRole('button', { name: /need you/ })).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('refused-host.png') })

  await main.getByRole('button', { name: 'Allow host' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(main.getByText('Allowed', { exact: true })).toBeVisible()
  const audit = await apiData<AuditPage>(request, '/audit?kind=task.host_allowed&limit=20')
  expect(audit.events.some((event) => event.summary.endsWith(`reach ${host}:443`))).toBe(true)
})
