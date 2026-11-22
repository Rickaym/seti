import type { APIRequestContext, Page } from '@playwright/test'
import type { MessagePage } from '@seti/shared'
import { apiData } from './fixtures.js'
import { startAgent } from './many-prs.js'
import { linkPrs, pr, prUrl, QUIET, RED } from './pr-ci.js'

/** Two PRs of one repo that fail CI, and a passing one. */
const STATUSES = [pr(RED, 5, { ci: 'failure' }), pr(RED, 6, { ci: 'failure' }), pr(QUIET, 1)]

export const BOTH = 'CI is failing on #5 and #6. Please fix them.'

/** Answers the batched status lookup with the fixture's PRs, as GitHub would. */
export async function mockFailing(page: Page): Promise<void> {
  await page.route(/\/api\/prs\/lookup$/, async (route) => {
    const asked = new Set((route.request().postDataJSON() as { urls: string[] }).urls)
    const prs = STATUSES.filter((item) => asked.has(item.url))
    await route.fulfill({ json: { data: { prs, pending: [] }, meta: {} } })
  })
}

/** An agent linked to red#5 and red#6, which fail, and to a passing PR. */
export async function agentWithTwoFailing(request: APIRequestContext, title: string) {
  const agent = await startAgent(request, title)
  await linkPrs(agent.id, [prUrl(RED, 5), prUrl(RED, 6), prUrl(QUIET, 1)])
  return agent
}

/** The messages the agent took as prompts, as the server holds them, without its start prompt. */
export async function promptsOf(request: APIRequestContext, agentId: string): Promise<string[]> {
  const { messages } = await apiData<MessagePage>(request, `/tasks/${agentId}/messages?limit=50`)
  return messages.flatMap((row) => (row.kind === 'prompt' ? [row.payload.text] : [])).slice(1)
}
