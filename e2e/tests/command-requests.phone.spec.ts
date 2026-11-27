import type { TaskMemoryCap } from '@seti/shared'
import { seedChangeRequest } from './support/change-requests.js'
import { apiData, expect, test } from './support/fixtures.js'
import { expectFitsPhone, expectTouchTarget } from './support/phone-layout.js'

test("an agent's proposed Seti command fits the phone and is allowed with a tap", async ({ page, request }) => {
  const change = {
    kind: 'command',
    line: '/seti:memory 1g',
    description: "Set this agent's memory cap to 1 GB, from 6 GB",
  }
  const { taskId } = await seedChangeRequest(change, `Asks for this change: ${change.description}`)

  await page.goto(`/#agents/${taskId}`)
  const card = page.getByRole('main').getByRole('region', { name: /^Change request: / })
  await expect(card).toContainText('+ /seti:memory 1g')
  await card.scrollIntoViewIfNeeded()
  await expectFitsPhone(page, 'command request')
  const allow = card.getByRole('button', { name: 'Allow', exact: true })
  await expectTouchTarget(allow)
  await test.info().attach('phone-command-card', { body: await page.screenshot(), contentType: 'image/png' })
  await allow.tap()
  await expect(card).toHaveCount(0)
  expect((await apiData<TaskMemoryCap>(request, `/tasks/${taskId}/memory`)).override?.max_mb).toBe(1024)
})
