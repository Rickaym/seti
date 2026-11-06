import type { MessagePage } from '@seti/shared'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { startAgent } from './support/grid.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const NOTE = 'Goes to the agent with your next message'

test('a ! result says it goes with the next message until a message carries it', async ({ page, request }) => {
  const id = await startAgent(request, unique('Shell note'))
  await page.goto(`/#agents/${id}`)
  const reply = page.getByRole('combobox', { name: 'Reply' })
  await reply.fill('!echo hi')
  await reply.press('Enter')
  const entry = page.locator('[data-kind="shell"]').filter({ hasText: 'echo hi' })
  await expect(entry).toContainText('exit 0')
  await expect(entry.getByTestId('shell-delivery')).toHaveText(NOTE)

  await reply.fill('thanks')
  await reply.press('Enter')
  await expect(entry.getByTestId('shell-delivery')).toHaveCount(0)
  const { messages } = await apiData<MessagePage>(request, `/tasks/${id}/messages?limit=200`)
  const sent = messages.findLast((row) => row.kind === 'prompt')
  expect(sent?.kind === 'prompt' ? sent.payload.inputs : undefined).toBe(1)
})
