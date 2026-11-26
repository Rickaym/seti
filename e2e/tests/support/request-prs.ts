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
export const DASH_URL = 'https://github.com/acme/dash/pull/3782'
export const DASH_TITLE = 'Add the lease renewal test'
/** PRs linked to the agent, which name the repositories it works in. */
export const AGENT_PRS = ['https://github.com/acme/dash/pull/3700', 'https://github.com/acme/tool/pull/9']
export const LIVE_DESCRIPTION = 'Confirm new test added, merge PR 3782'
/** A live merge: an unrelated diff piped through a regex first, no -R, no cd on the line. */
export const LIVE_MERGE = [
  "git diff origin/staging...abc123 -- path/file.test.ts | grep -E '^\\+.*(it|describe)\\(' ;",
  'gh pr merge 3782 --squash && sleep 4 &&',
  `gh pr view 3782 --json state,mergeCommit --jq '"#3782 \\(.state) \\(.mergeCommit.oid[0:8])"' | tee -a /tmp/ops.log`,
].join(' ')

const RETRY_URL = 'https://github.com/acme/tool/pull/2140'
export const RETRY_TITLE = 'Retry lease renewal on 503'

/** GitHub as the fake gh answers it: the lease fix open with green CI, and the retry merged. */
export function seedLeasePr(): void {
  setFakeGh('e2e', {
    [LEASE_URL]: { ...prNode(LEASE_URL, 'OPEN'), title: LEASE_TITLE, commits: rollup('SUCCESS') },
    [RETRY_URL]: { ...prNode(RETRY_URL, 'MERGED'), title: RETRY_TITLE, commits: rollup('SUCCESS') },
    [DASH_URL]: { ...prNode(DASH_URL, 'OPEN'), title: DASH_TITLE, commits: rollup('SUCCESS') },
  })
}

/** The command with the description the agent gives it. */
export const described = (command: string, description: string) => `${command}${DESCRIPTION_MARK}${description}`

/** Starts an agent that asks to run the command, and waits until it is blocked on the request. */
export async function startAsking(
  request: APIRequestContext,
  command: string,
  prUrls: readonly string[] = [],
): Promise<string> {
  const prompt = `Please ${COMMAND_PROMPT} ${command}`
  const response = await request.post('/api/tasks', {
    data: { title: unique('PR merger'), prompt, sandbox: false, ...(prUrls.length > 0 ? { pr_urls: prUrls } : {}) },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  started.push(id)
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).blocked).not.toBeNull()
  return id
}

/** Agents the test started, archived after it so none is left waiting on the user. */
const started: string[] = []

/** Notes an agent the test started another way, to archive it with the rest. */
export function track(id: string): void {
  started.push(id)
}

/** Archives the agents the test started, so other specs on this server find nobody waiting. */
export async function archiveStarted(request: APIRequestContext): Promise<void> {
  const ids = started.splice(0)
  if (ids.length > 0) {
    const response = await request.post('/api/tasks/archive', { data: { task_ids: ids, remove_worktree: false } })
    expect(response.ok(), 'POST /api/tasks/archive').toBe(true)
  }
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
