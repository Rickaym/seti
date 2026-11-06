import { randomUUID } from 'node:crypto'
import type { EaContext, EaSearchResult } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test } from './support/fixtures.js'

const DECISION =
  'Decision: keep the email domain when redacting addresses, so support can still route tickets to the right team.'

test('settings show what the EA knows, and search finds what a task decided', async ({ page, request }) => {
  // Seeding sends no task event, so the context and index catch up on their 30 s and 15 s cycles.
  test.setTimeout(90_000)
  const db = openSeedDb()
  const taskId = randomUUID()
  const at = new Date().toISOString()
  await db.idleTask(taskId, 'Redact transcripts', paths.root, at)
  const said = { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: DECISION }] } }
  await db.message(taskId, 'sdk', JSON.stringify(said), at)
  await db.close()

  await expect
    .poll(async () => (await apiData<EaContext>(request, '/ea/context')).text, { timeout: 40_000 })
    .toContain('"Redact transcripts" IDLE')

  await page.goto('/#settings/ea')
  const card = page.getByRole('region', { name: 'EA context' })
  await card.getByRole('button', { name: 'Refresh' }).click()
  await expect(card.getByLabel('Live context')).toContainText('Seti live context as of')
  await expect(card.getByLabel('Live context')).toContainText('"Redact transcripts" IDLE')
  await expect(card).toContainText(' tokens, as of ')
  await expect(card).toContainText(' documents, ')

  await expect
    .poll(
      async () => {
        const found = await apiData<EaSearchResult>(request, '/ea/search?q=email%20domain&mode=text')
        return found.hits.map((hit) => hit.task_title)
      },
      { timeout: 40_000 },
    )
    .toContain('Redact transcripts')
})
