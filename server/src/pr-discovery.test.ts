import type { MessageBody } from '@seti/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { messages, sql, tasks } from './db.js'
import type { PrHead } from './github.js'
import { createPrDiscovery, prCandidates, prDiscovery, type PrDiscoveryDeps } from './pr-discovery.js'
import { prDiscoveryStore, prDismissals, type StoredRow } from './store/pr-discovery.js'
import { linkTaskPr, unlinkTaskPr } from './tasks.js'

type ExecCallback = (error: Error | null, result?: { stdout: string; stderr: string }) => void

const gh = vi.hoisted(() => ({
  calls: [] as string[][],
  fail: false,
  heads: new Map<string, { url: string; headRefName: string; headRepository: { nameWithOwner: string } | null }>(),
}))

vi.mock('node:child_process', () => ({
  execFile: (_file: string, args: string[], _options: unknown, callback: ExecCallback) => {
    gh.calls.push(args)
    if (gh.fail) {
      callback(Object.assign(new Error('gh failed'), { stderr: 'HTTP 502: Bad Gateway\n' }))
      return
    }
    const urls = args.filter((arg) => /^u\d+=/.test(arg)).map((arg) => arg.slice(arg.indexOf('=') + 1))
    const data = Object.fromEntries(urls.map((url, index) => [`p${String(index)}`, gh.heads.get(url) ?? null]))
    callback(null, { stdout: JSON.stringify({ data }), stderr: '' })
  },
}))

const pr = (repo: string, n: number) => `https://github.com/Octocat/${repo}/pull/${String(n)}`

const sdk = (payload: unknown): StoredRow => ({ kind: 'sdk', payload: JSON.stringify(payload) })
const prompt = (text: string): StoredRow => ({ kind: 'prompt', payload: JSON.stringify({ text }) })

describe('prCandidates', () => {
  it('finds PRs in agent text, tool results, subagent messages and task notifications, once each', () => {
    const rows = [
      sdk({ type: 'assistant', message: { content: [{ type: 'text', text: `Opened ${pr('web', 1)}.` }] } }),
      sdk({
        type: 'user',
        parent_tool_use_id: 'toolu_agent',
        message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: `${pr('api', 2)}\n` }] },
      }),
      sdk({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: pr('web', 3) }] }],
        },
      }),
      sdk({ type: 'system', subtype: 'task_notification', summary: `Done: ${pr('ops', 4)}` }),
      sdk({ type: 'system', subtype: 'code_change_published', url: pr('web', 1) }),
      { kind: 'input', payload: JSON.stringify({ source: 'pr', body: `See ${pr('web', 5)}` }) },
    ] satisfies StoredRow[]
    expect(prCandidates(rows)).toEqual([pr('web', 1), pr('api', 2), pr('web', 3), pr('ops', 4), pr('web', 5)])
  })

  it('leaves out prompts the user typed but keeps subagent reports stored as prompts', () => {
    const relayed = `Another Claude session sent a message:\n<agent-message from="a1">\nOpened ${pr('web', 7)}`
    const notice = `<task-notification>\n<result>${pr('web', 8)}</result>\n</task-notification>`
    expect(prCandidates([prompt(`Look at ${pr('web', 6)}`), prompt(relayed), prompt(notice)])).toEqual([
      pr('web', 7),
      pr('web', 8),
    ])
  })
})

function harness(rows: Map<number, StoredRow>, heads: Map<string, PrHead | null>) {
  const cursors = new Map<string, number>()
  const links: string[] = []
  const errors: unknown[] = []
  const upTo = (last: number) => [...rows].filter(([id]) => id <= last)
  const deps: PrDiscoveryDeps = {
    cursor: async (taskId) => Promise.resolve(cursors.get(taskId) ?? 0),
    setCursor: async (taskId, id) => {
      cursors.set(taskId, id)
      return Promise.resolve()
    },
    lastMessageId: async () => Promise.resolve(Math.max(0, ...rows.keys())),
    rowsBetween: vi.fn(async (_taskId: string, after: number, last: number) =>
      Promise.resolve(
        upTo(last)
          .filter(([id]) => id > after)
          .map(([, row]) => row),
      ),
    ),
    evidenceRows: vi.fn(async (_taskId: string, last: number) => Promise.resolve(upTo(last).map(([, row]) => row))),
    linked: async () => Promise.resolve([]),
    dismissed: async () => Promise.resolve(new Set<string>()),
    fetch: vi.fn(async (urls: readonly string[]) =>
      Promise.resolve(new Map(urls.map((url) => [url, heads.get(url) ?? null]))),
    ),
    link: async (taskId, url, found) => Promise.resolve(links.push(`${taskId} ${url} (${found})`) > 0),
    taskIds: async () => Promise.resolve(['t1']),
    onError: (e) => errors.push(e),
    sleep: vi.fn(async () => Promise.resolve()),
  }
  return { deps, discovery: createPrDiscovery(deps), cursors, links, errors }
}

const OPENED = 'opened by the task'
const PUSHED = 'the task pushed its head branch'

const said = (text: string) => sdk({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const bash = (id: string, command: string) =>
  sdk({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })
const output = (id: string, content: string) =>
  sdk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } })
const headOf = (url: string, ref: string, repo = 'Octocat/web'): PrHead => ({ url, head_ref: ref, head_repo: repo })
const pushOf = (branch: string): [number, StoredRow][] => [
  [1, bash('p', `git push -u origin ${branch}`)],
  [2, output('p', '')],
]

describe('createPrDiscovery', () => {
  it('scans only rows after the cursor and asks GitHub once per URL', async () => {
    const rows = new Map([
      [1, bash('p', 'git push -u origin fix/a fix/b')],
      [2, output('p', '')],
      [3, said(pr('web', 1))],
    ])
    const heads = new Map([
      [pr('web', 1), headOf(pr('web', 1), 'fix/a')],
      [pr('web', 2), headOf(pr('web', 2), 'fix/b')],
    ])
    const { deps, discovery, cursors, links } = harness(rows, heads)
    await discovery.run('t1')
    expect(links).toEqual([`t1 ${pr('web', 1)} (${PUSHED})`])
    expect(cursors.get('t1')).toBe(3)

    rows.set(4, said(`again ${pr('web', 1)} and ${pr('web', 2)}`))
    await discovery.run('t1')
    expect(deps.rowsBetween).toHaveBeenLastCalledWith('t1', 3, 4)
    expect(deps.fetch).toHaveBeenLastCalledWith([pr('web', 2)])
    expect(cursors.get('t1')).toBe(4)

    await discovery.run('t1')
    expect(deps.rowsBetween).toHaveBeenCalledTimes(2)
  })

  it('links one PR once when the transcript spells its URL two ways', async () => {
    const lower = 'https://github.com/octocat/web/pull/1'
    const rows = new Map([...pushOf('fix/a'), [3, said(`${pr('web', 1)} ${lower}`)]])
    const heads = new Map([
      [pr('web', 1), headOf(pr('web', 1), 'fix/a')],
      [lower, headOf(pr('web', 1), 'fix/a')],
    ])
    const { discovery, links } = harness(rows, heads)
    await discovery.run('t1')
    expect(links).toEqual([`t1 ${pr('web', 1)} (${PUSHED})`])
  })

  it('links a PR its own gh pr create printed without asking GitHub', async () => {
    const rows = new Map([
      [1, bash('c', 'gh pr create --fill')],
      [2, output('c', `${pr('web', 9)}\n`)],
    ])
    const { deps, discovery, links } = harness(rows, new Map())
    await discovery.run('t1')
    expect(links).toEqual([`t1 ${pr('web', 9)} (${OPENED})`])
    expect(deps.fetch).not.toHaveBeenCalled()
  })

  it('links the PRs Claude Code reports the session created or pushed to', async () => {
    const report = (url: string, action: string) =>
      sdk({ type: 'system', subtype: 'code_change_published', provider: 'github', url, action })
    const rows = new Map([
      [1, report(pr('web', 1), 'created')],
      [2, report(pr('web', 2), 'pushed')],
      [3, report(pr('web', 3), 'commented')],
    ])
    const { deps, discovery, links } = harness(rows, new Map())
    await discovery.run('t1')
    expect(links).toEqual([`t1 ${pr('web', 1)} (${OPENED})`, `t1 ${pr('web', 2)} (${PUSHED})`])
    expect(deps.fetch).not.toHaveBeenCalled()
  })

  it('never links a PR another agent posted to chat.md, though the same user opened it just now', async () => {
    const url = pr('voice-bot', 1460)
    const chat = `### 226 @optimize, 2026-10-01 08:46Z\n**@optimize**: Core Tests fixed in ${url}.`
    const rows = new Map([
      [1, bash('r', 'cd $SETI_WORKSPACE; cat task.md; echo ---; tail -30 chat.md; ls packs')],
      [2, output('r', `# This task\n- Repos: none\n---\n${chat}`)],
    ])
    const heads = new Map([[url, headOf(url, 'perf/core-tests-ci-speedup', 'Octocat/voice-bot')]])
    const { deps, discovery, links, cursors } = harness(rows, heads)
    await discovery.run('t1')
    expect(links).toEqual([])
    expect(deps.fetch).not.toHaveBeenCalled()
    expect(cursors.get('t1')).toBe(2)
  })

  it('never links a PR from a team mention, gh pr view, list or checks, beside its own pushes', async () => {
    const theirs = pr('voice-bot', 1448)
    const listed = pr('voice-bot', 1440)
    const mention = { source: 'team', kind: 'mention', body: `@wed That is agent PR #1448 (${theirs})` }
    const rows = new Map<number, StoredRow>([
      ...pushOf('chore/cut-release-10.9.0'),
      [3, { kind: 'input', payload: JSON.stringify(mention) }],
      [4, bash('v', 'gh pr view 1448 --json url,state; gh pr list --limit 5')],
      [5, output('v', `${theirs}\tOPEN\n${listed}\tOPEN`)],
      [6, bash('k', 'gh pr checks 1448')],
      [7, output('k', `CI pass ${theirs}/checks`)],
    ])
    const heads = new Map([
      [theirs, headOf(theirs, 'fix/pii-llm-default-model', 'Octocat/voice-bot')],
      [listed, headOf(listed, 'feat/other', 'Octocat/voice-bot')],
    ])
    const { discovery, links } = harness(rows, heads)
    await discovery.run('t1')
    expect(links).toEqual([])
  })

  it('links a PR whose head branch the task pushed, also when it learns the URL later', async () => {
    const quiet = 'cd ~/wt && git switch -q -c ci/gates && git push -q -u origin ci/gates 2>&1 | grep -v remote'
    const rows = new Map([
      [1, bash('p', quiet)],
      [2, output('p', '')],
    ])
    const heads = new Map([[pr('web', 1403), headOf(pr('web', 1403), 'ci/gates')]])
    const { discovery, links } = harness(rows, heads)
    await discovery.run('t1')
    expect(links).toEqual([])

    rows.set(3, bash('l', 'gh pr list --head ci/gates --json url'))
    rows.set(4, output('l', pr('web', 1403)))
    await discovery.run('t1')
    expect(links).toEqual([`t1 ${pr('web', 1403)} (${PUSHED})`])
  })

  it('ignores a push that was rejected or went to another repo', async () => {
    const rows = new Map([
      [1, bash('a', 'git push origin fix/a')],
      [2, output('a', 'To github.com:Octocat/web.git\n ! [rejected]        fix/a -> fix/a (fetch first)')],
      [3, bash('b', 'git push')],
      [4, output('b', 'To github.com:Octocat/api.git\n   1a2b3c4..5d6e7f8  fix/b -> fix/b')],
      [5, said(`${pr('web', 1)} ${pr('web', 2)}`)],
    ])
    const heads = new Map([
      [pr('web', 1), headOf(pr('web', 1), 'fix/a')],
      [pr('web', 2), headOf(pr('web', 2), 'fix/b')],
    ])
    const { discovery, links } = harness(rows, heads)
    await discovery.run('t1')
    expect(links).toEqual([])
  })

  it('skips linked and dismissed PRs, unreadable URLs and PRs it did not push', async () => {
    const urls = [pr('web', 1), pr('web', 2), pr('web', 3), pr('web', 4), pr('web', 5)]
    const rows = new Map([
      [1, bash('p', 'git push -u origin fix/a fix/b fix/d')],
      [2, output('p', '')],
      [3, said(urls.join(' '))],
    ])
    const heads = new Map<string, PrHead | null>([
      [pr('web', 1), headOf(pr('web', 1), 'fix/a')],
      [pr('web', 2), headOf(pr('web', 2), 'fix/b')],
      [pr('web', 4), headOf(pr('web', 4), 'fix/d')],
      [pr('web', 5), headOf(pr('web', 5), 'fix/e')],
    ])
    const { deps, discovery, links } = harness(rows, heads)
    deps.linked = async () => Promise.resolve([pr('web', 1)])
    deps.dismissed = async () => Promise.resolve(new Set([pr('web', 2)]))
    await discovery.run('t1')
    expect(deps.fetch).toHaveBeenCalledWith([pr('web', 3), pr('web', 4), pr('web', 5)])
    expect(links).toEqual([`t1 ${pr('web', 4)} (${PUSHED})`])
  })

  it('logs failures, keeps the cursor and retries on the next run', async () => {
    const rows = new Map([...pushOf('fix/a'), [3, said(pr('web', 1))]])
    const heads = new Map([[pr('web', 1), headOf(pr('web', 1), 'fix/a')]])
    const { deps, discovery, cursors, links, errors } = harness(rows, heads)
    const fetch = deps.fetch
    deps.fetch = async () => Promise.reject(new Error('HTTP 502'))
    await expect(discovery.run('t1')).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
    expect(cursors.has('t1')).toBe(false)

    deps.fetch = fetch
    await discovery.run('t1')
    expect(links).toEqual([`t1 ${pr('web', 1)} (${PUSHED})`])
  })

  it('does nothing for a task without messages, such as a deleted one', async () => {
    const { deps, discovery, links } = harness(new Map(), new Map())
    await discovery.run('t1')
    expect(deps.rowsBetween).not.toHaveBeenCalled()
    expect(links).toEqual([])
  })

  it('backfills every task, pausing only after tasks that asked GitHub, and never throws', async () => {
    const rows = new Map([...pushOf('fix/a'), [3, said(pr('web', 1))]])
    const { deps, discovery, errors } = harness(rows, new Map([[pr('web', 1), headOf(pr('web', 1), 'fix/a')]]))
    deps.taskIds = async () => Promise.resolve(['t1', 't2', 't3'])
    await discovery.backfill()
    expect(deps.sleep).toHaveBeenCalledTimes(1)

    deps.taskIds = async () => Promise.reject(new Error('database is locked'))
    await expect(discovery.backfill()).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
  })
})

describe('prDiscovery with the store and gh', () => {
  let counter = 0
  const taskWith = async (bodies: MessageBody[]) => {
    counter += 1
    const id = `discovery-${String(counter)}`
    await tasks.insert({ id, title: 'Discovery', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
    for (const body of bodies) {
      await messages.insert(id, body, [])
    }
    return id
  }
  const asBody = (row: StoredRow) => ({ kind: 'sdk', payload: JSON.parse(row.payload) as unknown }) as MessageBody
  const text = (value: string) => asBody(said(value))
  const pushed = (branch: string): MessageBody[] => [
    asBody(bash(`push-${branch}`, `git push -u origin ${branch}`)),
    asBody(output(`push-${branch}`, `To github.com:Octocat/web.git\n * [new branch]      ${branch} -> ${branch}`)),
  ]
  const headed = (url: string, branch: string) =>
    gh.heads.set(url, { url, headRefName: branch, headRepository: { nameWithOwner: 'Octocat/web' } })
  const graphqlCalls = () => gh.calls.filter((args) => args[1] === 'graphql')

  beforeEach(() => {
    gh.calls = []
    gh.fail = false
  })

  it('asks GitHub in batches of 20 URLs', async () => {
    const urls = Array.from({ length: 45 }, (_, index) => pr('web', 1000 + index))
    const owned = urls.filter((_, index) => index % 20 === 0)
    owned.forEach((url) => headed(url, 'fix/batch'))
    const id = await taskWith([...pushed('fix/batch'), text(urls.join('\n'))])
    await prDiscovery.run(id)
    expect(graphqlCalls().map((args) => args.filter((arg) => /^u\d+=/.test(arg)).length)).toEqual([20, 20, 5])
    expect((await tasks.get(id))?.pr_urls).toEqual(owned)
  })

  it('links with the discovered source, audits why, and moves the cursor to the last message', async () => {
    headed(pr('web', 101), 'fix/101')
    const thanks: MessageBody = { kind: 'prompt', payload: { text: 'thanks' } }
    const id = await taskWith([...pushed('fix/101'), text(pr('web', 101)), thanks])
    await prDiscovery.run(id)
    expect((await tasks.get(id))?.pr_urls).toEqual([pr('web', 101)])
    expect([...(await sql`SELECT source FROM task_pr WHERE task_id = ${id}`)]).toEqual([{ source: 'discovered' }])
    const audit = await sql<{ summary: string }[]>`SELECT summary FROM audit_event
      WHERE subject_id = ${id} AND kind = 'task.pr_linked'`
    expect(audit.map((row) => row.summary)).toEqual([`Linked PR Octocat/web#101 (${PUSHED})`])
    expect(await prDiscoveryStore.cursor(id)).toBe(await prDiscoveryStore.lastMessageId(id))
  })

  it('links a PR the task opened, and never one it only read about', async () => {
    headed(pr('web', 110), 'perf/core-tests')
    const id = await taskWith([
      asBody(bash('r', 'tail -30 chat.md')),
      asBody(output('r', `@optimize: fixed in ${pr('web', 110)}`)),
      asBody(bash('c', 'gh pr create --fill')),
      asBody(output('c', pr('web', 111))),
    ])
    await prDiscovery.run(id)
    expect((await tasks.get(id))?.pr_urls).toEqual([pr('web', 111)])
    expect(graphqlCalls()).toEqual([])
  })

  it('never relinks a PR the user unlinked, until the user links it again', async () => {
    headed(pr('web', 102), 'fix/102')
    const id = await taskWith([...pushed('fix/102'), text(pr('web', 102))])
    await prDiscovery.run(id)
    expect(await unlinkTaskPr(id, pr('web', 102))).toBe(true)
    expect(await prDismissals.list(id)).toEqual(new Set([pr('web', 102)]))

    await messages.insert(id, text(`still ${pr('web', 102)}`), [])
    await prDiscovery.run(id)
    expect((await tasks.get(id))?.pr_urls).toEqual([])

    expect(await linkTaskPr(id, pr('web', 102))).toBe(true)
    expect((await prDismissals.list(id)).size).toBe(0)
  })

  it('does not throw when gh fails, and links once gh is back', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    headed(pr('web', 103), 'fix/103')
    const id = await taskWith([...pushed('fix/103'), text(pr('web', 103))])
    gh.fail = true
    await expect(prDiscovery.run(id)).resolves.toBeUndefined()
    expect((await tasks.get(id))?.pr_urls).toEqual([])
    expect(await prDiscoveryStore.cursor(id)).toBe(0)
    gh.fail = false
    await prDiscovery.run(id)
    expect((await tasks.get(id))?.pr_urls).toEqual([pr('web', 103)])
    stderr.mockRestore()
  })
})
