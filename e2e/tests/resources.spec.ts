import { resourcesSchema, resourceSummarySchema } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'
import { HUNG_TASK, mockResources, QUIET_TASK } from './support/resources.js'

test('the resources page shows the host, tasks and components, and stops a hung task', async ({ page }) => {
  const stopped = await mockResources(page)
  await page.goto('/#settings/resources')
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: 'Resources', level: 2 })).toBeVisible()

  const anomalies = main.getByRole('region', { name: 'Anomalies' })
  await expect(anomalies.getByRole('heading')).toHaveText('5 anomalies')
  await expect(anomalies.getByRole('listitem').first()).toContainText('71% CPU for 4 min in Bash with no child process')
  await expect(anomalies.getByRole('img', { name: 'critical' })).toHaveCount(1)

  const host = main.getByRole('region', { name: 'Host' })
  await expect(host.getByRole('group', { name: 'CPU' })).toContainText('91%')
  await expect(host.getByRole('group', { name: 'CPU' })).toContainText('8 CPUs, load 17.2 15.1 11.8')
  await expect(host.getByRole('group', { name: 'Swap' })).toContainText('98%')
  await expect(host.getByRole('img', { name: /^Host CPU, last hour: now 90%/ })).toBeVisible()
  await expect(host).toContainText('holds Seti home, Postgres data, Claude home')

  const tasks = main.getByRole('region', { name: 'Agents' })
  const rows = tasks.getByRole('row')
  await expect(rows.nth(1)).toHaveAccessibleName(HUNG_TASK.title)
  const hung = tasks.getByRole('row', { name: HUNG_TASK.title })
  await expect(hung).toContainText('Hung tool call')
  await expect(hung).toContainText('2.5 GB +400 MB swap')
  await expect(hung).toContainText('git status --short')
  await expect(hung).toContainText('node')
  await expect(hung.getByRole('link', { name: HUNG_TASK.title })).toHaveAttribute('href', `#agents/${HUNG_TASK.id}`)
  const quiet = tasks.getByRole('row', { name: QUIET_TASK.title })
  await expect(quiet.getByRole('img', { name: /^Unsandboxed/ })).toBeVisible()
  await expect(quiet.getByRole('button', { name: /^Stop/ })).toHaveCount(0)

  await hung.getByRole('button', { name: `Stop ${HUNG_TASK.title}` }).click()
  await expect.poll(() => stopped).toEqual([`/api/tasks/${HUNG_TASK.id}/stop`])

  const components = main.getByRole('region', { name: 'Seti components' })
  await expect(components.getByRole('row', { name: 'EA service' })).toContainText('down')
  await expect(components.getByRole('row', { name: 'PostgreSQL' })).toContainText('database 45 MB')
  await expect(components.getByRole('row', { name: 'cloudflared' })).toContainText('off')
  await expect(main).toContainText('each sample takes 6.2 ms, 5.1 ms of it on the CPU')
})

test('the status bar shows memory, fills with the anomaly count once one is critical and opens the page', async ({
  page,
}) => {
  await mockResources(page)
  await page.goto('/#agents')
  const item = page.getByRole('contentinfo').getByRole('button', { name: 'Resources' })
  await expect(item).toContainText('73%')
  await expect(item.getByTestId('resource-anomalies')).toHaveText('5')
  await expect(item).toHaveAttribute('data-tone', 'critical')
  await item.click()
  await expect(page).toHaveURL(/#settings\/resources$/)
  await expect(page.getByRole('main').getByRole('heading', { name: 'Resources', level: 2 })).toBeVisible()
})

test('the real server answers both resource routes in their shapes', async ({ request, page }) => {
  const resources = resourcesSchema.parse(await apiData(request, '/resources'))
  expect(resources.components.find((c) => c.id === 'server')?.state).toBe('up')
  resourceSummarySchema.parse(await apiData(request, '/resources/summary'))
  await page.goto('/#agents')
  await expect(page.getByRole('contentinfo').getByRole('button', { name: 'Resources' })).toContainText('%')
})
