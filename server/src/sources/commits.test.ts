import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { claudeToolCall, type ClaudeMessage } from '@seti/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { tasks } from '../db.js'
import { nodeLink } from '../node-link.js'
import { commitAsk, commitItems } from './commits.js'
import { itemText } from './item.js'
import { matchSources } from './match.js'
import { refOfUrl } from './refs.js'

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

function git(dir: string, ...args: string[]): string {
  const named = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', dir, ...args]
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- tests use the git on PATH like git.ts
  return execFileSync('git', named, { env: ENV, encoding: 'utf8', stdio: 'pipe' }).trimEnd()
}

/** A clone of acme/notes: a pushed commit, then one not pushed. */
function clone(origin = 'https://github.com/acme/notes.git') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-commits-'))
  git(dir, 'init', '-q')
  fs.writeFileSync(path.join(dir, 'a.md'), 'one\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'the rollout moves to Monday')
  git(dir, 'remote', 'add', 'origin', origin)
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  const pushed = git(dir, 'rev-parse', 'HEAD')
  fs.writeFileSync(path.join(dir, 'a.md'), 'two\n')
  git(dir, 'commit', '-qam', 'a local change')
  return { dir, pushed, local: git(dir, 'rev-parse', 'HEAD') }
}

let counter = 0
async function taskIn(cwd: string): Promise<string> {
  const id = `ledger-commits-${String(++counter)}`
  await tasks.insert({ id, title: id, repo_id: null, cwd, worktree: false, pr_urls: [] })
  return id
}

beforeAll(() => {
  createApp()
})

async function recorded(task: string, command: string, text: string) {
  const ask = commitAsk(claudeToolCall('call-1', 'Bash', { command }))
  const items = ask === null ? [] : await commitItems(task, ask, text)
  return items.map((item) => ({ ref: item.ref, permalink: item.permalink, text: itemText(text, item.spans) }))
}

describe('commits an agent shows with git', () => {
  it('records each commit of a git log, linked when origin holds it', async () => {
    const { dir, pushed, local } = clone()
    const text = git(dir, 'log', '-p')
    const found = await recorded(await taskIn(dir), 'git log -p', text)
    expect(found.map(({ ref, permalink }) => ({ ref, permalink }))).toEqual([
      { ref: `github:acme/notes@${local}`, permalink: '' },
      { ref: `github:acme/notes@${pushed}`, permalink: `https://github.com/acme/notes/commit/${pushed}` },
    ])
    expect(found[1]?.text).toContain('the rollout moves to Monday')
    expect(found[0]?.text).not.toContain('the rollout moves to Monday')
  })

  it.each([
    ['a folder change', (dir: string, sha: string) => `cd ${dir} && git show ${sha}`],
    ['git -C and a filter that only cuts', (dir: string, sha: string) => `git -C ${dir} show ${sha} | head -40`],
  ])('follows %s from another folder', async (_name, line) => {
    const { dir, pushed } = clone()
    const found = await recorded(await taskIn(path.dirname(dir)), line(dir, pushed), git(dir, 'show', pushed))
    expect(found.map(({ ref }) => ref)).toEqual([`github:acme/notes@${pushed}`])
  })

  it.each([
    ['a format option', 'git log --oneline'],
    ['another command that prints', 'echo hi; git log -p'],
    ['a loop', 'for r in a b; do git log -p; done'],
    ['git settings on the line', 'git -c core.pager=cat log -p'],
    ["git's environment", 'GIT_DIR=/elsewhere git log -p'],
    ['output sent to a file', 'git log -p > /tmp/log.txt'],
    ['a filter that adds text', "git log -p | sed 's/a/b/'"],
  ])('records nothing for %s', async (_name, command) => {
    const { dir } = clone()
    expect(await recorded(await taskIn(dir), command, git(dir, 'log', '-p'))).toEqual([])
  })

  it('records nothing for a commit the clone does not hold or a clone of another host', async () => {
    const { dir } = clone()
    const other = clone('https://git.example.com/acme/notes.git')
    const fake = `commit ${'c'.repeat(40)}\nAuthor: t\n\n    made up\n`
    expect(await recorded(await taskIn(dir), 'git show', fake)).toEqual([])
    expect(await recorded(await taskIn(other.dir), 'git log -p', git(other.dir, 'log', '-p'))).toEqual([])
  })

  it('matches a commit link by its short hash and verifies a quote from its message', async () => {
    const { dir, pushed } = clone()
    const task = await taskIn(dir)
    const use = { type: 'assistant', parent_tool_use_id: null, message: { content: [] as object[] } }
    use.message.content.push({
      type: 'tool_use',
      id: 'toolu_git',
      name: 'Bash',
      input: { command: `git show ${pushed}` },
    })
    const answer = git(dir, 'show', pushed)
    const result = {
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_git', content: answer }] },
    }
    for (const payload of [use, result] as unknown as ClaudeMessage[]) {
      await nodeLink.journal(task, { type: 'message', runtime: 'claude', payload })
    }
    const href = `https://github.com/acme/notes/commit/${pushed.slice(0, 8)}`
    const [hit, tip, other] = await matchSources(task, [
      { href, quote: 'the rollout moves to Monday' },
      { href: 'https://github.com/acme/notes/commit/main', quote: 'the rollout moves to Monday' },
      { href: 'https://github.com/acme/notes/commit/dev', quote: null },
    ])
    expect(hit).toMatchObject({ verified: true, source: { kind: 'github', container: 'acme/notes' } })
    expect(hit?.as_read_at).toBeUndefined()
    expect(tip).toMatchObject({ verified: true, as_read_at: pushed.slice(0, 7) })
    expect(other).toMatchObject({ source: null, unread: false })
  })

  it.each([
    [`https://github.com/acme/notes/commit/${'a'.repeat(40)}`, `github:acme/notes@${'a'.repeat(40)}`, undefined],
    ['https://github.com/Acme/Notes/commit/abc1234', 'github:acme/notes@abc1234', true],
    ['https://github.com/acme/notes/commit/main', 'github:acme/notes@', undefined],
    ['https://github.com/acme/notes/commit/abc1234/extra', null, undefined],
  ])('%s names %s', (url, ref, prefix) => {
    const found = refOfUrl(url)
    expect(found?.ref ?? null).toBe(ref)
    expect(found?.prefix).toBe(prefix)
  })
})
