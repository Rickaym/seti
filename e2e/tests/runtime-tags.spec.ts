import { codexOff, codexReady } from './support/codex.js'
import { expect, test } from './support/fixtures.js'
import { mockTaggedServers } from './support/runtime-tags.js'

test.afterEach(async ({ request }) => {
  await codexOff(request)
})

test('the capabilities pages tag a row Codex cannot use only while Codex is on', async ({ page, request }) => {
  await mockTaggedServers(page)
  await page.goto('/#settings/mcp')
  const main = page.getByRole('main')
  await expect(main.getByText('events', { exact: true })).toBeVisible()
  await expect(main.getByText('Claude only')).toHaveCount(0)

  await codexReady(request)
  await page.reload()
  const events = main.getByRole('listitem').filter({ hasText: 'events' })
  await expect(events.getByText('Claude only')).toBeVisible()
  await expect(main.getByRole('listitem').filter({ hasText: 'docs' }).getByText('Claude only')).toHaveCount(0)
  await events.getByText('Claude only').hover()
  await expect(page.getByRole('tooltip')).toContainText('Codex agents cannot use this.')

  await page.goto('/#settings/plugins')
  await expect(main.getByText('Claude only').first()).toBeVisible()
})
