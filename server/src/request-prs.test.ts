import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PermissionRequest, Task } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { tasks } from './db.js'
import { git } from './git.js'
import { addPermissionRule } from './permission-rules.js'
import type { DetailAnswer } from './pr-details.js'
import { endSession, runTurn } from './runner.js'
import { USER_AUTH } from './test-auth.js'

/**
 * Asks to run the command its prompt names, as Claude Code does for a call no rule allows:
 * `<command> ## <description> @@ <folder the shell is in>`. With a description it hands that on
 * as the call's description and gives no reason of its own, as Claude Code did live.
 */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeAssistant, fakeResult } = await import('./fake-sdk.js')
  const fake = new FakeSdk(async function* (turn) {
    const { canUseTool, hooks } = turn.session.options
    const [said = '', cwd] = turn.text.split(' @@ ')
    const [command = '', description] = said.split(' ## ')
    const input = description === undefined ? { command } : { command, description }
    const event = {
      session_id: 's',
      transcript_path: '',
      cwd: cwd ?? '/tmp',
      hook_event_name: 'PreToolUse' as const,
      tool_name: 'Bash',
      tool_input: input,
      tool_use_id: 'toolu_pr',
    }
    const bash = (hooks?.PreToolUse ?? []).filter((m) => m.matcher === undefined || m.matcher === 'Bash')
    if (cwd !== undefined) {
      for (const hook of bash.flatMap((m) => m.hooks)) {
        await hook(event, 'toolu_pr', { signal: turn.signal })
      }
    }
    const rule = { toolName: 'Bash', ruleContent: command }
    const options = {
      signal: turn.signal,
      toolUseID: 'toolu_pr',
      requestId: 'req_pr',
      ...(description === undefined ? { decisionReason: 'Merge the fix' } : { description }),
      suggestions: [
        { type: 'addRules' as const, behavior: 'allow' as const, destination: 'localSettings' as const, rules: [rule] },
      ],
    }
    const result = await canUseTool?.('Bash', input, options)
    yield fakeAssistant(JSON.stringify(result ?? null))
    yield fakeResult()
  })
  return { fake, query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

/** GitHub's answer, held until a test lets it go. */
const lookup = vi.hoisted(() => {
  let release: () => void = () => undefined
  let held = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    calls: [] as string[][],
    held: async () => held,
    release: () => {
      release()
    },
    hold: () => {
      held = new Promise<void>((resolve) => {
        release = resolve
      })
    },
  }
})

vi.mock('./pr-details.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  prDetails: async (urls: readonly string[]): Promise<DetailAnswer> => {
    lookup.calls.push([...urls])
    await lookup.held()
    const pr = { title: 'Fix lease renewal after TTL', ci: 'success' }
    const dash = { title: 'Add the lease renewal test', ci: 'pending' }
    const known: Record<string, unknown> = { 'acme/tool/pull/2136': pr, 'acme/dash/pull/3782': dash }
    const detail = (url: string) => known[url.replace('https://github.com/', '')] ?? null
    return { details: new Map(urls.map((url) => [url, detail(url)])), pending: [] } as never
  },
}))

vi.mock('./github-pr-states.js', () => ({
  prStates: async (urls: readonly string[]) =>
    Promise.resolve(
      new Map(
        urls
          .filter((url) => url.endsWith('/7'))
          .map((url) => [url, { title: 'Retry the lease', state: 'merged', ci: 'success' }]),
      ),
    ),
}))

const app = createApp()
const headers = { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' }
const created: string[] = []

async function newTask(cwd = '/tmp', prUrls: string[] = []): Promise<Task> {
  const id = `request-prs-task-${String(created.length + 1)}`
  await tasks.insert({ id, title: id, repo_id: null, cwd, worktree: false, pr_urls: prUrls })
  created.push(id)
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('no task')
  }
  return task
}

async function requests(taskId: string): Promise<PermissionRequest[]> {
  const res = await app.request(`/api/tasks/${taskId}/permission-requests`, { headers })
  return ((await res.json()) as { data: PermissionRequest[] }).data.filter((r) => r.state === 'pending')
}

async function pending(taskId: string, until: (request: PermissionRequest) => boolean = () => true) {
  return vi.waitFor(
    async () => {
      const [request] = await requests(taskId)
      if (request === undefined || !until(request)) {
        throw new Error('Not yet')
      }
      return request
    },
    { interval: 10, timeout: 5000 },
  )
}

afterAll(async () => {
  for (const id of created) {
    await endSession(id)
  }
})

describe('the PRs a request names', () => {
  it('shows the request and its PR links before GitHub answers, then their title and CI', async () => {
    lookup.hold()
    const task = await newTask()
    await runTurn(task.id, 'gh pr merge 2136 -R acme/tool --merge 2>&1 | tail -2; gh pr view 7 -R acme/tool')
    const linked = await pending(task.id, (request) => request.prs.length > 0)
    expect(linked.prs).toEqual([
      {
        url: 'https://github.com/acme/tool/pull/2136',
        repo: 'acme/tool',
        number: 2136,
        title: null,
        ci: null,
        state: null,
      },
      { url: 'https://github.com/acme/tool/pull/7', repo: 'acme/tool', number: 7, title: null, ci: null, state: null },
    ])
    await vi.waitFor(() => {
      expect(lookup.calls.at(-1)).toEqual(linked.prs.map((pr) => pr.url))
    })

    lookup.release()
    const filled = await pending(task.id, (request) => request.prs[0]?.title !== null)
    expect(filled.prs[0]).toMatchObject({ title: 'Fix lease renewal after TTL', ci: 'success' })
    expect(filled.prs[0]).toMatchObject({ state: 'open' })
    expect(filled.prs[1]).toMatchObject({ title: 'Retry the lease', ci: 'success', state: 'merged' })
  })

  it('reads the repository of the folder the command runs in, and names none for other calls', async () => {
    lookup.release()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-prs-'))
    await git(dir, 'init', '-q')
    await git(dir, 'remote', 'add', 'origin', 'git@github.com:acme/tool.git')
    try {
      const task = await newTask(dir)
      await runTurn(task.id, 'gh pr checks 31')
      expect((await pending(task.id, (request) => request.prs.length > 0)).prs[0]?.url).toBe(
        'https://github.com/acme/tool/pull/31',
      )

      const plain = await newTask()
      await runTurn(plain.id, 'make deploy')
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect((await pending(plain.id)).prs).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('offers no Always when an ask rule holds the command, and Always without one', async () => {
    lookup.release()
    const held = await newTask()
    await addPermissionRule(held, { behavior: 'ask', rule: 'Bash(gh pr merge:*)' })
    await runTurn(held.id, 'gh pr merge 5 -R acme/tool')
    expect((await pending(held.id)).suggestions).toEqual([])

    const free = await newTask()
    await runTurn(free.id, 'gh pr merge 5 -R acme/tool')
    expect((await pending(free.id)).suggestions).toEqual(['Bash(gh pr merge 5 -R acme/tool)'])
  })

  it("keeps the agent's description as one plain, short line, and the reason line reads it", async () => {
    const task = await newTask()
    const said = `Merge \u202Etool#5\n  now${'!'.repeat(300)}`
    await runTurn(task.id, `gh pr merge 5 -R acme/tool ## ${said}`)
    const request = await pending(task.id)
    expect(request.summary).toBe('gh pr merge 5 -R acme/tool')
    expect(request.description?.startsWith('Merge tool#5 now!!!')).toBe(true)
    expect(request.description).toHaveLength(200)
    const blocked = await vi.waitFor(async () => {
      const line = (await tasks.get(task.id))?.blocked ?? null
      expect(line).not.toBeNull()
      return line
    })
    expect(blocked?.startsWith('Asks to use Bash: Merge tool#5 now')).toBe(true)

    const plain = await newTask()
    await runTurn(plain.id, 'gh pr view 6 -R acme/tool')
    expect((await pending(plain.id)).description).toBeNull()
  })

  it('names the ask rule that holds a live merge, never the description, and finds the PR where the shell cd-ed', async () => {
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'request-prs-clone-'))
    await git(clone, 'init', '-q')
    await git(clone, 'remote', 'add', 'origin', 'https://github.com/acme/dash.git')
    try {
      const task = await newTask()
      await addPermissionRule(task, { behavior: 'ask', rule: 'Bash(gh pr merge:*)' })
      await addPermissionRule(task, { behavior: 'allow', rule: 'PushTo(acme)' })
      const merge = `gh pr merge 3782 --squash && sleep 4 && gh pr view 3782 --json state,mergeCommit --jq '"#3782 \\(.state)"' | tee -a /abs/ops.log`
      const command = `git diff origin/staging...abc123 -- path/file.test.ts | grep -E '^\\+.*(it|describe)\\(' ; ${merge}`
      await runTurn(task.id, `${command} ## Confirm new test added, merge PR 3782 @@ ${clone}`)
      const request = await pending(task.id, (one) => one.prs[0]?.title !== null && one.prs.length > 0)
      expect(request.description).toBe('Confirm new test added, merge PR 3782')
      expect(request.reason).toBe('Your Ask rule holds this: Bash(gh pr merge:*)')
      expect(request.suggestions).toEqual([])
      expect(request.prs).toEqual([
        {
          url: 'https://github.com/acme/dash/pull/3782',
          repo: 'acme/dash',
          number: 3782,
          title: 'Add the lease renewal test',
          ci: 'pending',
          state: 'open',
        },
      ])
    } finally {
      fs.rmSync(clone, { recursive: true, force: true })
    }
  })

  it('shows no reason line rather than the description when nothing says why', async () => {
    const task = await newTask()
    await runTurn(task.id, 'make deploy ## Ship the build')
    const request = await pending(task.id)
    expect(request.description).toBe('Ship the build')
    expect(request.reason).toBeNull()
  })

  it("guesses a bare number in the agent's own repositories when the folder names none", async () => {
    const linked = ['https://github.com/acme/dash/pull/3700', 'https://github.com/acme/tool/pull/9']
    const one = await newTask('/tmp', linked)
    await runTurn(one.id, 'gh pr merge 3782 --squash')
    const found = await pending(one.id, (request) => request.prs.length > 0)
    expect(found.prs.map((pr) => pr.url)).toEqual(['https://github.com/acme/dash/pull/3782'])

    const both = await newTask('/tmp', linked)
    await runTurn(both.id, 'gh pr view 7')
    const guessed = await pending(both.id, (request) => request.prs.length > 1)
    expect(guessed.prs.map((pr) => pr.repo)).toEqual(['acme/dash', 'acme/tool'])

    const none = await newTask('/tmp', linked)
    await runTurn(none.id, 'gh pr view 8')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((await pending(none.id)).prs).toEqual([])
  })
})
