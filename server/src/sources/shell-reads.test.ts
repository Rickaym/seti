import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { claudeToolCall, type ClaudeMessage } from '@seti/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { tasks } from '../db.js'
import { nodeLink } from '../node-link.js'
import { itemText } from './item.js'
import { lookupSources } from './lookup.js'
import { matchSources } from './match.js'
import { shellReadAsk, shellReadItems } from './shell-reads.js'

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
function git(dir: string, ...args: string[]): string {
  const named = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', dir, ...args]
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- tests use the git on PATH like git.ts
  return execFileSync('git', named, { env: ENV, encoding: 'utf8', stdio: 'pipe' }).trim()
}

const LINES = Array.from({ length: 12 }, (_, i) => `step ${String(i + 1)} of the rollout plan`)
const lines = (from: number, to: number) => LINES.slice(from - 1, to).join('\n')

/** A clone of acme/notes with one pushed commit holding `docs/plan.md` and `git/show.md`. */
function clone(): { dir: string; sha: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-shell-'))
  fs.mkdirSync(path.join(dir, 'docs'))
  fs.mkdirSync(path.join(dir, 'git'))
  fs.writeFileSync(path.join(dir, 'docs', 'plan.md'), `${LINES.join('\n')}\n`)
  fs.writeFileSync(path.join(dir, 'git', 'show.md'), 'how to show a commit with git\n')
  git(dir, 'init', '-q')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'first')
  git(dir, 'remote', 'add', 'origin', 'https://github.com/acme/notes.git')
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  return { dir, sha: git(dir, 'rev-parse', 'HEAD') }
}

let counter = 0
async function taskIn(cwd: string): Promise<string> {
  const id = `ledger-shell-${String(++counter)}`
  await tasks.insert({ id, title: id, repo_id: null, cwd, worktree: false, pr_urls: [] })
  return id
}

beforeAll(() => {
  createApp()
})

async function recorded(task: string, command: string, text: string) {
  const ask = shellReadAsk(claudeToolCall('call-1', 'Bash', { command }))
  const items = ask === null ? [] : await shellReadItems(task, ask, text)
  return items.map((item) => ({ permalink: item.permalink, text: itemText(text, item.spans) }))
}

/** The agent runs a shell line, and Seti ingests the call and its result. */
let calls = 0
async function agentRuns(taskId: string, command: string, answer: string): Promise<void> {
  const id = `toolu_shell_${String(++calls)}`
  const use = { type: 'assistant', parent_tool_use_id: null, message: { content: [] as object[] } }
  use.message.content.push({ type: 'tool_use', id, name: 'Bash', input: { command } })
  const result = {
    type: 'user',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: answer }] },
  }
  for (const payload of [use, result] as unknown as ClaudeMessage[]) {
    await nodeLink.journal(taskId, { type: 'message', runtime: 'claude', payload })
  }
}

describe('files an agent prints with the shell in a GitHub clone', () => {
  it.each([
    ['cat docs/plan.md', lines(1, 12), ''],
    ['head -n 3 docs/plan.md', lines(1, 3), '#L1-L3'],
    ['head -4 docs/plan.md', lines(1, 4), '#L1-L4'],
    ['head docs/plan.md', lines(1, 10), '#L1-L10'],
    ["sed -n '4,6p' docs/plan.md", lines(4, 6), '#L4-L6'],
    ['sed -n 7p docs/plan.md', lines(7, 7), '#L7-L7'],
    ['sed -n 10,20p docs/plan.md', lines(10, 12), '#L10-L12'],
    ['tail -n +11 docs/plan.md', lines(11, 12), '#L11-L12'],
    ['tail -n 20 docs/plan.md', lines(1, 12), ''],
    ['cat -- docs/plan.md', lines(1, 12), ''],
  ])('records `%s` with the lines it printed', async (command, text, anchor) => {
    const { dir, sha } = clone()
    const found = await recorded(await taskIn(dir), command, `${text}\n`)
    const permalink = `https://github.com/acme/notes/blob/${sha}/docs/plan.md${anchor}`
    expect(found).toEqual([{ permalink, text: `${text}\n` }])
  })

  it('reads nl output without its line numbers', async () => {
    const { dir } = clone()
    const numbered = LINES.map((line, i) => `${String(i + 1).padStart(6)}\t${line}`).join('\n')
    const found = await recorded(await taskIn(dir), 'nl docs/plan.md', numbered)
    expect(found[0]?.text).toBe(lines(1, 12))
  })

  it('follows a folder change and an absolute path', async () => {
    const { dir, sha } = clone()
    const task = await taskIn(path.dirname(dir))
    const permalink = `https://github.com/acme/notes/blob/${sha}/docs/plan.md#L1-L2`
    for (const command of [`cd ${dir} && head -n 2 docs/plan.md`, `head -n 2 ${dir}/docs/plan.md`]) {
      expect((await recorded(task, command, lines(1, 2)))[0]?.permalink).toBe(permalink)
    }
  })

  it('records each file of a line of plain reads with the lines asked and no text', async () => {
    const { dir, sha } = clone()
    const command = 'head -n 2 docs/plan.md; sed -n 5,6p docs/plan.md'
    const found = await recorded(await taskIn(dir), command, `${lines(1, 2)}\n${lines(5, 6)}`)
    const blob = `https://github.com/acme/notes/blob/${sha}/docs/plan.md`
    expect(found).toEqual([
      { permalink: `${blob}#L1-L2`, text: null },
      { permalink: `${blob}#L5-L6`, text: null },
    ])
  })

  it.each([
    ['a pipe into a filter', 'cat docs/plan.md | cut -c1-5'],
    ['a pipe into head', 'cat docs/plan.md | head -n 2'],
    ['a redirect of errors', 'cat docs/plan.md 2>/dev/null'],
    ['output sent to a file', 'cat docs/plan.md > copy.md'],
    ['a glob', 'cat docs/*.md'],
    ['a substitution', 'cat $(echo docs/plan.md)'],
    ['a variable', 'cat $F'],
    ['an option that changes the text', 'cat -n docs/plan.md'],
    ['two files', 'cat docs/plan.md git/show.md'],
    ['sed without -n', 'sed 5p docs/plan.md'],
    ['a sed script that does more', "sed -n '5,6p;8p' docs/plan.md"],
    ['a sed range to the end', "sed -n '10,$p' docs/plan.md"],
    ['another command that prints', 'sed -n 5,6p docs/plan.md && grep step docs/plan.md'],
    ['a byte count', 'head -c 10 docs/plan.md'],
    ['all but the last lines', 'head -n -2 docs/plan.md'],
    ['a fallback', 'cat docs/plan.md || true'],
    ['a loop', 'for f in a; do cat docs/plan.md; done'],
    ['a pager', 'less docs/plan.md'],
    ['bat', 'bat docs/plan.md'],
    ['an assignment', 'LC_ALL=C cat docs/plan.md'],
    ['a folder change that prints', 'cd - && cat docs/plan.md'],
    ['a background read', 'cat docs/plan.md &'],
  ])('records nothing for %s', async (_name, command) => {
    const { dir } = clone()
    expect(await recorded(await taskIn(dir), command, lines(1, 12))).toEqual([])
  })

  it('records nothing when the result holds more lines than the read prints', async () => {
    const { dir } = clone()
    expect(await recorded(await taskIn(dir), 'head -n 2 docs/plan.md', lines(1, 3))).toEqual([])
  })

  it('records the last lines only when they were the whole file', async () => {
    const { dir } = clone()
    expect(await recorded(await taskIn(dir), 'tail -n 3 docs/plan.md', lines(10, 12))).toEqual([])
  })

  it('verifies a quote only from the lines a partial read printed', async () => {
    const { dir, sha } = clone()
    const task = await taskIn(dir)
    await agentRuns(task, 'cat git/show.md', 'how to show a commit with git')
    await agentRuns(task, "sed -n '4,6p' docs/plan.md", lines(4, 6))
    const blob = `https://github.com/acme/notes/blob/${sha.slice(0, 7)}/docs/plan.md#L4-L6`
    const [inside, outside, other] = await matchSources(task, [
      { href: blob, quote: 'step 5 of the rollout plan' },
      { href: blob, quote: 'step 8 of the rollout plan' },
      { href: `https://github.com/acme/notes/blob/${sha}/git/show.md`, quote: 'show a commit with git' },
    ])
    expect(inside).toMatchObject({ verified: true, source: { kind: 'file', container: 'acme/notes' } })
    expect(outside).toMatchObject({ verified: false, source: { kind: 'file' } })
    expect(other).toMatchObject({ verified: true })
  })

  it('names the lines of a local copy in a lookup', async () => {
    const { dir } = clone()
    fs.appendFileSync(path.join(dir, 'docs', 'plan.md'), 'a local step\n')
    const task = await taskIn(dir)
    await agentRuns(task, 'head -n 2 docs/plan.md', lines(1, 2))
    const { items } = await lookupSources(task, { kind: 'file', limit: 10 })
    expect(items.map((item) => item.place)).toEqual(['acme/notes/docs/plan.md lines 1-2 (local file)'])
    expect(items[0]?.permalink).toBe('')
  })
})
