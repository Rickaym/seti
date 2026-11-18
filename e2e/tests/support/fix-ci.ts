import type { APIRequestContext, Page } from '@playwright/test'
import type { FixCiPlan, MessagePage } from '@seti/shared'
import { apiData, expect } from './fixtures.js'
import { startAgent } from './many-prs.js'
import { linkPrs, pr, prUrl, QUIET, RED } from './pr-ci.js'

const OTHER = 'e2e/other'

/** Two PRs of one repo and one of another, all failing CI, and a passing one. */
const STATUSES = [
  pr(RED, 5, { ci: 'failure' }),
  pr(RED, 6, { ci: 'failure' }),
  pr(OTHER, 9, { ci: 'failure' }),
  pr(QUIET, 1),
]

export const BOTH = 'CI is failing on #5 and #6. Please fix them.'
export const ACROSS = 'CI is failing on e2e/other#9 and e2e/red#6. Please fix them.'

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

export interface TwoAgents {
  first: { id: string; title: string }
  second: { id: string; title: string }
}

/**
 * Two agents with failing PRs of their own, and Seti's plan for them as the Agents list reads it:
 * one archived agent and two failing PRs with no agent are left out.
 */
export async function twoAgentsToNudge(page: Page, request: APIRequestContext, label: string): Promise<TwoAgents> {
  const first = await startAgent(request, `${label} one`)
  const second = await startAgent(request, `${label} two`)
  const idle = { status: 'idle' } as const
  const plan: FixCiPlan = {
    nudges: [
      {
        task: { ...idle, id: first.id, title: first.title },
        prs: [
          { repo_slug: RED, number: 5 },
          { repo_slug: RED, number: 6 },
        ],
        message: BOTH,
      },
      {
        task: { ...idle, id: second.id, title: second.title },
        prs: [
          { repo_slug: OTHER, number: 9 },
          { repo_slug: RED, number: 6 },
        ],
        message: ACROSS,
      },
    ],
    skipped: [{ task: { ...idle, id: 'archived-agent', title: 'Old agent' }, reason: 'archived' }],
    unlinked: 2,
    error: null,
  }
  await page.route(/\/api\/prs\/fix-ci$/, async (route) => route.fulfill({ json: { data: plan, meta: {} } }))
  return { first, second }
}

/** The confirm of the Agents list's Fix CI: who it reaches and what it skips. */
export async function expectNudgeConfirm(page: Page, agents: TwoAgents): Promise<void> {
  const confirm = page.getByRole('dialog', { name: 'Fix CI' })
  await expect(confirm).toContainText('Nudge 2 agents about 3 PRs')
  await expect(confirm).toContainText(agents.first.title)
  await expect(confirm).toContainText(agents.second.title)
  await expect(confirm).toContainText('Skipped Old agent (archived). Skipped 2 failing PRs with no agent.')
}

/** The messages the agent took as prompts, as the server holds them, without its start prompt. */
export async function promptsOf(request: APIRequestContext, agentId: string): Promise<string[]> {
  const { messages } = await apiData<MessagePage>(request, `/tasks/${agentId}/messages?limit=50`)
  return messages.flatMap((row) => (row.kind === 'prompt' ? [row.payload.text] : [])).slice(1)
}
