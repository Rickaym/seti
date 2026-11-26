import type { APIRequestContext, Page } from '@playwright/test'
import type { Envelope, Task } from '@seti/shared'
import { prNode, setFakeGh } from './fake-gh-env.js'
import { COMMAND_PROMPT, DESCRIPTION_MARK } from './fake-permission.js'
import { apiData, expect, unique } from './fixtures.js'

export const LEASE_TITLE = 'Fix lease renewal after TTL'
export const LEASE_URL = 'https://github.com/acme/tool/pull/2136'
export const MERGE = 'gh pr merge 2136 -R acme/tool --merge 2>&1 | tail -2; gh pr view 2136 -R acme/tool --json state'

const rollup = (state: 'SUCCESS' | 'FAILURE') => ({
  nodes: [{ commit: { oid: 'abc1234def', statusCheckRollup: { state, contexts: { nodes: [] } } } }],
})

export const MERGE_DESCRIPTION = 'Merge tool#2136 once its checks pass'
export const RETRY_URL = 'https://github.com/acme/tool/pull/2140'
export const RETRY_TITLE = 'Retry lease renewal on 503'

/** GitHub as the fake gh answers it: the lease fix open with green CI, and the retry merged. */
export function seedLeasePr(): void {
  setFakeGh('e2e', {
    [LEASE_URL]: { ...prNode(LEASE_URL, 'OPEN'), title: LEASE_TITLE, commits: rollup('SUCCESS') },
    [RETRY_URL]: { ...prNode(RETRY_URL, 'MERGED'), title: RETRY_TITLE, commits: rollup('SUCCESS') },
  })
}

/** The command with the description the agent gives it. */
export const described = (command: string, description: string) => `${command}${DESCRIPTION_MARK}${description}`

/** Starts an agent that asks to run the command, and waits until it is blocked on the request. */
export async function startAsking(request: APIRequestContext, command: string): Promise<string> {
  const response = await request.post('/api/tasks', {
    data: { title: unique('PR merger'), prompt: `Please ${COMMAND_PROMPT} ${command}`, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).blocked).not.toBeNull()
  return id
}

export const requestCard = (page: Page) =>
  page.getByRole('main').getByRole('region', { name: 'Permission request for Bash' })

/** Adds a global ask rule for the rest of the test; returns what removes it. */
export async function addAskRule(request: APIRequestContext, rule: string): Promise<() => Promise<void>> {
  const response = await request.post('/api/permissions/rules', { data: { behavior: 'ask', rule } })
  expect(response.ok(), 'POST /api/permissions/rules').toBe(true)
  const { id } = ((await response.json()) as Envelope<{ id: number }>).data
  return async () => {
    expect((await request.delete(`/api/permissions/rules/${String(id)}`)).ok()).toBe(true)
  }
}
