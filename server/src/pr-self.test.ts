import { beforeAll, describe, expect, it } from 'vitest'
import { sql, tasks } from './db.js'
import type { PrPost } from './pr-events.js'
import { agentPostings, agentPosts, callWindow, ownPosts, type AgentPosting } from './pr-self.js'
import { postTargets } from './pr-target.js'

const PR = 'https://github.com/acme/web/pull/7'

const use = (id: string, name: string, input: unknown) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
const result = (id: string, content: string) =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } })

const post = (id: string, login: string, at: string, overrides: Partial<PrPost> = {}): PrPost => ({
  id,
  url: `${PR}#issuecomment-${id}`,
  inline: [],
  login,
  at,
  ...overrides,
})

const at = (time: string) => Date.parse(`2026-10-07T${time}Z`)

describe('agentPostings', () => {
  it('finds the posting calls and the anchors their output links', () => {
    const rows = [
      { payload: use('t1', 'Bash', { command: `gh pr comment 7 --body "Fixed"` }), created_at: '2026-10-07T10:00:00Z' },
      { payload: result('t1', `${PR}#issuecomment-99`), created_at: '2026-10-07T10:00:02Z' },
      { payload: use('t2', 'Bash', { command: 'gh pr review 7 --approve' }), created_at: '2026-10-07T10:01:00Z' },
      { payload: result('t2', 'Approved pull request acme/web#7'), created_at: '2026-10-07T10:01:01Z' },
      { payload: use('t3', 'Bash', { command: 'gh pr view 7 --comments' }), created_at: '2026-10-07T10:02:00Z' },
      { payload: result('t3', `${PR}#issuecomment-55`), created_at: '2026-10-07T10:02:01Z' },
      {
        payload: use('t4', 'mcp__github__add_issue_comment', { body: 'Done' }),
        created_at: '2026-10-07T10:03:00Z',
      },
      {
        payload: result('t4', JSON.stringify({ html_url: `${PR}#discussion_r123` })),
        created_at: '2026-10-07T10:03:01Z',
      },
      { payload: use('t5', 'mcp__github__get_pull_request_comments', {}), created_at: '2026-10-07T10:04:00Z' },
    ]
    expect(agentPostings(rows)).toEqual([
      { at: at('10:00:00'), anchors: ['issuecomment-99'], targets: [{ repo: null, number: 7 }] },
      { at: at('10:01:00'), anchors: [], targets: [{ repo: null, number: 7 }] },
      { at: at('10:03:00'), anchors: ['discussion_r123'], targets: [] },
    ])
  })

  it('counts gh api writes to comments and reviews, but not reads', () => {
    const rows = [
      'gh api repos/acme/web/issues/7/comments -f body=hi',
      'gh api repos/acme/web/pulls/7/comments/5/replies -X POST -f body=ok',
      'gh api repos/acme/web/pulls/7/reviews --method GET',
      'gh api repos/acme/web/pulls/7/comments',
    ].map((command, index) => ({
      payload: use(`a${String(index)}`, 'Bash', { command }),
      created_at: '2026-10-07T10:00:00Z',
    }))
    expect(agentPostings(rows)).toHaveLength(2)
  })

  it('counts a GraphQL call only when it adds a comment or review', () => {
    const read =
      `gh api graphql -f query='query{repository(owner:"acme",name:"api"){pullRequest(number:3)` +
      `{reviewThreads(first:20){nodes{id comments(first:1){nodes{databaseId}}}}}}}' | while read id; do ` +
      `gh api graphql -f query="mutation{resolveReviewThread(input:{threadId:\\"$id\\"}){thread{isResolved}}}"; done`
    const add = `gh api graphql -f query='mutation{addComment(input:{subjectId:"PR_1",body:"hi"}){clientMutationId}}'`
    const rows = [read, add].map((command, index) => ({
      payload: use(`g${String(index)}`, 'Bash', { command }),
      created_at: '2026-10-07T10:00:00Z',
    }))
    expect(agentPostings(rows)).toEqual([{ at: at('10:00:00'), anchors: [], targets: [] }])
  })
})

describe('postTargets', () => {
  const bash = (command: string) => postTargets('Bash', { command })

  it('reads the PR a gh comment or review names, with its repo where given', () => {
    expect(bash('gh pr comment 7 --body "see #9"')).toEqual([{ repo: null, number: 7 }])
    expect(bash('gh pr comment --repo acme/web -b "Fixed; thanks" 7')).toEqual([{ repo: 'acme/web', number: 7 }])
    expect(bash('gh pr review -R=github.com/acme/web --approve 7')).toEqual([{ repo: 'acme/web', number: 7 }])
    expect(bash(`gh pr comment ${PR} -b ok`)).toEqual([{ repo: 'acme/web', number: 7 }])
    expect(bash('cd /w && gh issue comment 12 -R acme/api -F body.md')).toEqual([{ repo: 'acme/api', number: 12 }])
  })

  it('reads the PR of a gh api path', () => {
    expect(bash('gh api repos/acme/web/issues/7/comments -f body=hi')).toEqual([{ repo: 'acme/web', number: 7 }])
    expect(bash('gh api "repos/{owner}/{repo}/pulls/7/comments/5/replies" -f body=ok')).toEqual([
      { repo: null, number: 7 },
    ])
    expect(bash('gh api repos/acme/web/issues/comments/5 -X PATCH -f body=x')).toEqual([])
  })

  it('names no PR for the current branch, a branch name or a variable', () => {
    expect(bash('gh pr comment -b "Done"')).toEqual([])
    expect(bash('gh pr comment fix/login -b "Done"')).toEqual([])
    expect(bash('for p in 1 2; do gh pr comment "$p" -b hi; done')).toEqual([])
  })

  it('reads the PR of a GitHub MCP call from its fields', () => {
    expect(postTargets('mcp__github__add_issue_comment', { owner: 'acme', repo: 'web', issue_number: 7 })).toEqual([
      { repo: 'acme/web', number: 7 },
    ])
    expect(postTargets('mcp__gh__create_review', { repo: 'acme/web', pullNumber: '7' })).toEqual([
      { repo: 'acme/web', number: 7 },
    ])
    expect(postTargets('mcp__github__add_issue_comment', { body: 'Done' })).toEqual([])
  })
})

describe('ownPosts', () => {
  it('matches posts by the anchors the calls linked, whoever the author', () => {
    const linked: AgentPosting[] = [{ at: at('10:00:00'), anchors: ['issuecomment-1', 'discussion_r9'], targets: [] }]
    const review = post('R1', 'agent-bot', '2026-10-07T10:00:05Z', {
      url: `${PR}#pullrequestreview-4`,
      inline: [`${PR}#discussion_r9`],
    })
    const posts = [post('1', 'agent-bot', '2026-10-07T10:00:03Z'), post('2', 'alice', '2026-10-07T10:00:04Z'), review]
    expect(ownPosts(posts, linked, 'octocat', PR)).toEqual(new Set(['1', 'R1']))
  })

  it('gives a call that linked nothing the first post by the gh user soon after it, and only one', () => {
    const calls: AgentPosting[] = [{ at: at('10:00:00'), anchors: [], targets: [] }]
    const posts = [
      post('1', 'Octocat', '2026-10-07T10:00:04Z'),
      post('2', 'octocat', '2026-10-07T10:02:00Z'),
      post('3', 'alice', '2026-10-07T09:59:59Z'),
    ]
    expect(ownPosts(posts, calls, 'octocat', PR)).toEqual(new Set(['1']))
  })

  it('keeps the gh user posts made long after or well before any posting call', () => {
    const calls: AgentPosting[] = [{ at: at('10:00:00'), anchors: [], targets: [] }]
    const posts = [post('1', 'octocat', '2026-10-07T10:15:00Z'), post('2', 'octocat', '2026-10-07T09:55:00Z')]
    expect(ownPosts(posts, calls, 'octocat', PR)).toEqual(new Set())
  })

  it('never gives the gh user a post to a call on another PR', () => {
    const user = [post('1', 'octocat', '2026-10-07T10:00:26Z')]
    const elsewhere = (repo: string | null, number: number): AgentPosting[] => [
      { at: at('10:00:00'), anchors: [], targets: [{ repo, number }] },
    ]
    expect(ownPosts(user, elsewhere('acme/api', 7), 'octocat', PR)).toEqual(new Set())
    expect(ownPosts(user, elsewhere(null, 1911), 'octocat', PR)).toEqual(new Set())
  })

  it('gives a call on the same PR the gh user post that followed it', () => {
    const user = [post('1', 'octocat', '2026-10-07T10:00:26Z')]
    const same: AgentPosting[] = [{ at: at('10:00:00'), anchors: [], targets: [{ repo: 'ACME/web', number: 7 }] }]
    const unnamedRepo: AgentPosting[] = [{ at: at('10:00:00'), anchors: [], targets: [{ repo: null, number: 7 }] }]
    expect(ownPosts(user, same, 'octocat', PR)).toEqual(new Set(['1']))
    expect(ownPosts(user, unnamedRepo, 'octocat', PR)).toEqual(new Set(['1']))
  })

  it('bounds the calls to look at by the post times', () => {
    expect(callWindow([post('1', 'a', '2026-10-07T10:00:00Z'), post('2', 'a', '2026-10-07T11:00:00Z')])).toEqual({
      from: '2026-10-07T09:50:00.000Z',
      to: '2026-10-07T11:10:00.000Z',
    })
    expect(callWindow([post('1', 'a', '2026-10-07T10:00:00Z', { at: null })])).toBeNull()
  })
})

describe('agentPosts', () => {
  beforeAll(async () => {
    await sql`INSERT INTO task (id, title, cwd, status, created_at, updated_at) VALUES
      ('poster', 'Poster', '/tmp', 'idle', '2026-10-07T08:00:00.000Z', '2026-10-07T08:00:00.000Z'),
      ('other', 'Other', '/tmp', 'idle', '2026-10-07T08:00:00.000Z', '2026-10-07T08:00:00.000Z')`
    await tasks.linkPr('poster', PR, 'agent')
    const rows: [string, string, string][] = [
      ['poster', use('p1', 'Bash', { command: 'gh pr review 7 --comment -b "Addressed"' }), '2026-10-07T10:00:00Z'],
      ['poster', result('p1', 'Reviewed pull request acme/web#7'), '2026-10-07T10:00:01Z'],
      ['other', use('o1', 'Bash', { command: 'gh pr comment 7 -b "From elsewhere"' }), '2026-10-07T10:30:00Z'],
      ['poster', use('p2', 'Bash', { command: 'gh pr comment 7 -b "Old"' }), '2026-10-06T10:00:00Z'],
    ]
    for (const [task, payload, created] of rows) {
      await sql`INSERT INTO task_message (task_id, kind, payload, created_at)
        VALUES (${task}, 'sdk', ${payload}, ${created})`
    }
  })

  it('reads the posting calls of the tasks linked to the PR around the posts', async () => {
    const review = post('R1', 'octocat', '2026-10-07T10:00:03Z', { url: `${PR}#pullrequestreview-1` })
    const user = post('2', 'octocat', '2026-10-07T10:30:02Z')
    expect(await agentPosts(PR, [review, user], 'octocat')).toEqual(new Set(['R1']))
  })
})
