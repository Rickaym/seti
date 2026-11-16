import { randomUUID } from 'node:crypto'
import type { PrList } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'
import { openAgentPrs } from './support/phone-agent.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { pr, QUIET } from './support/pr-ci.js'

const LIST: PrList = { viewer: 'e2e', prs: [pr(QUIET, 1)], error: null, more: 12, refreshing: false, previews_on: true }

test('the phone PR picker says how many open PRs it does not list', async ({ page }) => {
  await page.route(/\/api\/prs$/, async (route) => route.fulfill({ json: { data: LIST, meta: {} } }))
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, 'E2E phone more PRs', paths.checkout, new Date().toISOString())
  await db.close()
  await page.goto(`/#agents/${id}`)
  const sheet = await openAgentPrs(page)
  await sheet.getByRole('button', { name: 'Link PR' }).tap()
  await expect(sheet.getByRole('button', { name: /quiet change 1/ })).toBeVisible()
  await expect(sheet.getByText('12 more open PRs not listed')).toBeVisible()
  await expectFitsPhone(page, 'PR picker with unlisted PRs')
  await page.request.delete(`/api/tasks/${id}`)
})
