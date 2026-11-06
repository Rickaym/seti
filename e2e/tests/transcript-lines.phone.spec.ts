import { randomUUID } from 'node:crypto'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

const CWD = '/home/user/work/help-me-setup-a-poller-in-seti-2b3364bf'
const SESSION = randomUUID()

const init = {
  type: 'system',
  subtype: 'init',
  session_id: SESSION,
  model: 'claude-opus-5-5',
  permissionMode: 'bypassPermissions',
  cwd: CWD,
  tools: [],
  mcp_servers: Array.from({ length: 12 }, (_, index) => ({ name: `server-${String(index)}`, status: 'connected' })),
  plugins: Array.from({ length: 10 }, (_, index) => ({
    name: `plugin-${String(index)}`,
    version: '1.0.0',
    path: `/home/user/.claude/plugins/cache/market/plugin-${String(index)}/1.0.0`,
  })),
  plugin_errors: [{ plugin: 'broken@market', type: 'generic-error', message: 'manifest is missing' }],
}

const failed = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  num_turns: 5,
  duration_ms: 12_400,
  seti_turn_cost_usd: 2.27,
  session_id: SESSION,
  uuid: randomUUID(),
}

async function seedTask(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date().toISOString()
  await db.idleTask(id, title, paths.checkout, ts)
  await db.message(id, 'prompt', JSON.stringify({ text: 'Set up a poller.' }), ts)
  await db.message(id, 'sdk', JSON.stringify(init), ts)
  await db.message(id, 'sdk', JSON.stringify(failed), ts)
  await db.close()
  return id
}

test('the session start and turn end read as short lines on a phone, with details on tap', async ({ page }) => {
  const id = await seedTask(unique('Phone lines'))
  await page.goto(`/#agents/${id}`)
  const pane = page.getByRole('main').getByRole('region', { name: 'Transcript' })
  const start = pane.locator('details').filter({ hasText: 'Session started' })
  await expect(start).toContainText(
    'Opus 5.5 \u00b7 bypass \u00b7 help-me-setup-a-poller-in-seti-2b3364bf \u00b7 12 MCP \u00b7 10 plugins',
  )
  await expect(start.getByText('1 plugin failed')).toBeVisible()
  await expect(start.getByText(CWD)).toBeHidden()
  await expect(
    pane.getByText('Turn failed: error during execution \u00b7 5 steps \u00b7 12s \u00b7 $2.27'),
  ).toBeVisible()
  await expectFitsPhone(page, 'session start and turn end lines')

  await start.locator('summary').tap()
  await expect(start.getByText(CWD)).toBeVisible()
  await expect(start.getByText(SESSION)).toBeVisible()
  await expect(start.getByText('broken@market: manifest is missing')).toBeVisible()
  await expectFitsPhone(page, 'session start details')
})
