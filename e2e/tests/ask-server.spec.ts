import type { AuditPage } from '@seti/shared'
import { addOffServer, allowAndTime, askingForServer, removeServer, requestCard } from './support/ask-server.js'
import { apiData, expect, test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const SERVER = 'e2e-ask-desk'

test('an agent told which server is off asks for it, and Allow gives its next turn the server', async ({
  page,
  request,
}, info) => {
  test.setTimeout(180_000)
  await addOffServer(request, SERVER)
  try {
    const task = await askingForServer(request, SERVER)

    await page.goto('/#agents')
    const row = page.getByRole('main').getByRole('region', { name: 'Needs you' }).locator(`[data-task-id="${task.id}"]`)
    await expect(row).toContainText(`Asks for the MCP server ${SERVER}`)
    await row.getByRole('button').first().click()
    await expect(requestCard(page)).toContainText(`+ ${SERVER}`)
    await expect(requestCard(page)).toContainText('The task posts a message there.')

    await allowAndTime(page, { task, server: SERVER, tap: false }, info)
    await expect(page.getByRole('main').locator('[data-input="seti-allowed"]')).toContainText(
      `The user turned on the MCP server ${SERVER} for you`,
    )
    const audit = await apiData<AuditPage>(request, '/audit?kind=task.change_allowed&limit=1')
    expect(audit.events[0]).toMatchObject({ actor: 'user', subject_id: task.id })
  } finally {
    await removeServer(request, SERVER)
  }
})
