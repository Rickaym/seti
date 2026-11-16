import type { APIRequestContext } from '@playwright/test'
import type { PrList, Repo } from '@seti/shared'
import { fakeGhEnv, prNode, setFakeGh } from './fake-gh-env.js'
import { apiData, expect, unique } from './fixtures.js'
import { startAgent } from './many-prs.js'
import { linkPrs } from './pr-ci.js'
import { FAKE_CLAUDE_ENV } from './processes.js'

/** The fake Claude Code for Fix CI, and a fake gh that knows PRs of repos Seti never heard of. */
export const ANY_REPO_ENV = { ...FAKE_CLAUDE_ENV, ...fakeGhEnv() }

const VIEWER = 'e2e-user'

const failing = (name: string) => ({
  __typename: 'CheckRun',
  name,
  status: 'COMPLETED',
  conclusion: 'FAILURE',
  detailsUrl: null,
  checkSuite: null,
})

const rollup = (state: 'FAILURE' | 'SUCCESS', contexts: readonly unknown[]) => ({
  nodes: [{ commit: { oid: 'abc1234def', statusCheckRollup: { state, contexts: { nodes: contexts } } } }],
})

export interface AnyRepoPrs {
  agent: { id: string; title: string }
  /** A teammate's PR with failing CI that the agent linked; its repo has a name of its own. */
  linked: { url: string; label: string; slug: string; title: string }
  /** A green PR of the gh login in another repo, linked to no agent. */
  authored: { url: string; label: string; slug: string; title: string }
}

/** An agent linked to a failing PR and an open PR of the login, in repos Seti has no checkout of. */
export async function seedAnyRepoPrs(request: APIRequestContext, label: string): Promise<AnyRepoPrs> {
  const [tool, site] = [unique('tool'), unique('site')]
  const linked = {
    url: `https://github.com/elsewhere/${tool}/pull/3`,
    label: `${tool}#3`,
    slug: `elsewhere/${tool}`,
    title: 'Fix the parser',
  }
  const authored = {
    url: `https://github.com/faraway/${site}/pull/12`,
    label: `${site}#12`,
    slug: `faraway/${site}`,
    title: 'Ship the landing page',
  }
  const red = {
    ...prNode(linked.url, 'OPEN'),
    title: linked.title,
    author: { login: 'teammate' },
    commits: rollup('FAILURE', [failing('build')]),
    reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }] },
  }
  const green = {
    ...prNode(authored.url, 'OPEN'),
    title: authored.title,
    author: { login: VIEWER },
    commits: rollup('SUCCESS', []),
  }
  setFakeGh(VIEWER, { [linked.url]: red, [authored.url]: green }, [green])
  const agent = await startAgent(request, label)
  await linkPrs(agent.id, [linked.url])
  return { agent, linked, authored }
}

/** Seti lists both PRs in full, names the owning agent, and has neither repo registered. */
export async function expectListedWithoutRepos(request: APIRequestContext, seeded: AnyRepoPrs): Promise<void> {
  const { agent, linked, authored } = seeded
  const slugs = (await apiData<Repo[]>(request, '/repos')).map((repo) => repo.slug)
  expect(slugs).not.toContain(linked.slug)
  expect(slugs).not.toContain(authored.slug)
  await expect
    .poll(async () => {
      const list = await apiData<PrList>(request, '/prs')
      return list.prs
        .filter((pr) => pr.url === linked.url || pr.url === authored.url)
        .map((pr) => [pr.repo_slug, pr.title, pr.ci, pr.unresolved_threads, pr.tasks.map((task) => task.id)])
    })
    .toEqual([
      [authored.slug, authored.title, 'success', 0, []],
      [linked.slug, linked.title, 'failure', 1, [agent.id]],
    ])
  expect((await apiData<PrList>(request, '/prs')).viewer).toBe(VIEWER)
}
