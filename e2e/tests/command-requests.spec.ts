import type { AuditPage, ChangeRequest, TaskMemoryCap } from '@seti/shared'
import { seedChangeRequest } from './support/change-requests.js'
import { apiData, expect, test } from './support/fixtures.js'

const MEMORY = {
  kind: 'command',
  line: '/seti:memory 1g',
  description: "Set this agent's memory cap to 1 GB, from 6 GB",
}

async function shot(name: string, body: Buffer): Promise<void> {
  await test.info().attach(name, { body, contentType: 'image/png' })
}

test("an agent's proposed Seti command shows on the same card, and Allow runs it as the user", async ({
  page,
  request,
}) => {
  const blocked = `Asks for this change: ${MEMORY.description}`
  const { taskId, requestId } = await seedChangeRequest(MEMORY, blocked, 'The build runs out of memory at link time.')

  await page.goto('/#agents')
  const row = page.getByRole('main').getByRole('region', { name: 'Needs you' }).locator(`[data-task-id="${taskId}"]`)
  await expect(row).toContainText('memory cap to 1 GB')
  await row.getByRole('button').first().click()
  const card = page.getByRole('main').getByRole('region', { name: /^Change request: / })
  await expect(card).toContainText(`${MEMORY.description}?`)
  await expect(card).toContainText('The build runs out of memory at link time.')
  await expect(card).toContainText('+ /seti:memory 1g')
  await expect(card).toContainText('Seti command for this agent')
  await shot('command-card', await card.screenshot())
  await card.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(card).toHaveCount(0)

  expect((await apiData<TaskMemoryCap>(request, `/tasks/${taskId}/memory`)).override?.max_mb).toBe(1024)
  expect(await apiData<ChangeRequest[]>(request, `/tasks/${taskId}/change-requests`)).toEqual([])
  const audit = await apiData<AuditPage>(request, '/audit?kind=task.change_allowed&limit=1')
  expect(audit.events[0]).toMatchObject({
    actor: 'user',
    subject_id: taskId,
    detail: { request_id: requestId, kind: 'command', command: '/seti:memory 1g' },
  })
  await expect(page.getByRole('main').locator('[data-input="seti-allowed"]')).toContainText(
    'The user allowed /seti:memory 1g',
  )
})

test('a host request card also shows the Seti command it is', async ({ page }) => {
  const change = { kind: 'allow_host', host: 'docs.fixtures.example.com', port: 443 }
  const { taskId } = await seedChangeRequest(change, 'Asks for access to docs.fixtures.example.com:443')
  await page.goto(`/#agents/${taskId}`)
  const card = page.getByRole('main').getByRole('region', { name: /^Change request: / })
  await expect(card.getByLabel('As a Seti command')).toHaveText('/seti:access host docs.fixtures.example.com add')
  await shot('host-card', await card.screenshot())
})
