import type { Page, Route } from '@playwright/test'
import type { MessagePage, SendMessageInput, TeamPostInput } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'
import { startAgent } from './support/many-prs.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV, allowedConsoleErrors: [/net::ERR_CONNECTION_RESET/] })

/** Lets the first POST reach the server, then drops its answer, as a flaky phone network does. */
async function loseFirstAnswer<T>(page: Page, url: string): Promise<T[]> {
  const bodies: T[] = []
  await page.route(url, async (route: Route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback()
      return
    }
    bodies.push(route.request().postDataJSON() as T)
    if (bodies.length === 1) {
      await route.fetch()
      await route.abort('connectionreset')
      return
    }
    await route.continue()
  })
  return bodies
}

test('a reply whose answer is lost is sent again with its id and lands once', async ({ page, request }) => {
  const agent = await startAgent(request, 'Lost answer')
  const bodies = await loseFirstAnswer<SendMessageInput>(page, `**/api/tasks/${agent.id}/messages`)
  await page.goto(`/#agents/${agent.id}`)
  const reply = page.getByRole('combobox', { name: 'Reply' })
  await reply.fill('Say this only once, please')
  await reply.press('Enter')

  await expect(reply).toHaveValue('')
  await expect.poll(() => bodies.length).toBe(2)
  expect(bodies[0]?.client_id).toMatch(/^[0-9a-f-]{36}$/)
  expect(bodies[1]?.client_id).toBe(bodies[0]?.client_id)

  const transcript = page.getByRole('main')
  await expect(transcript.getByText('Say this only once, please', { exact: true })).toHaveCount(1)
  await expect(page.locator('[data-pending-send]')).toHaveCount(0)
  const rows = await apiData<MessagePage>(request, `/tasks/${agent.id}/messages?limit=100`)
  const prompts = rows.messages.filter(
    (row) => row.kind === 'prompt' && JSON.stringify(row.payload).includes('Say this only once, please'),
  )
  expect(prompts).toHaveLength(1)
})

test('a group chat post whose answer is lost is posted once', async ({ page, request }) => {
  const text = `Lost post ${Date.now().toString(36)}`
  const bodies = await loseFirstAnswer<TeamPostInput>(page, '**/api/team/messages')
  await page.goto('/#agents')
  await page.keyboard.press('Control+Shift+L')
  const chat = page.getByRole('complementary', { name: 'Group chat' })
  const box = chat.getByRole('combobox', { name: 'Message the group' })
  await box.fill(text)
  await box.press('Enter')

  await expect(box).toHaveValue('')
  expect(bodies).toHaveLength(2)
  expect(bodies[1]?.client_id).toBe(bodies[0]?.client_id)
  await expect(chat.getByText(text, { exact: true })).toHaveCount(1)
  const posted = await apiData<{ text: string }[]>(request, '/team/messages?limit=200')
  expect(posted.filter((message) => message.text === text)).toHaveLength(1)
})
