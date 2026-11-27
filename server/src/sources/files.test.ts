import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { claudeToolCall, type ClaudeMessage } from '@seti/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { nodeLink } from '../node-link.js'
import { quietTask } from '../threads/test-slack-kit.js'
import { fileAsk, fileItems, githubRemote } from './files.js'
import { itemText } from './item.js'
import { lookupSources } from './lookup.js'
import { matchSources } from './match.js'
import { refOfUrl } from './refs.js'

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
function git(dir: string, ...args: string[]): string {
  const named = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', dir, ...args]
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- tests use the git on PATH like git.ts
  return execFileSync('git', named, { env: ENV, encoding: 'utf8', stdio: 'pipe' }).trim()
}

/** A clone of acme/notes with one pushed commit holding `docs/a.md`. */
function clone(origin = 'https://github.com/acme/notes.git'): { dir: string; sha: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-clone-'))
  fs.mkdirSync(path.join(dir, 'docs'))
  fs.writeFileSync(path.join(dir, 'docs', 'a.md'), 'one\ntwo\nthree\n')
  git(dir, 'init', '-q')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'first')
  if (origin !== '') {
    git(dir, 'remote', 'add', 'origin', origin)
  }
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  return { dir, sha: git(dir, 'rev-parse', 'HEAD') }
}

const READ_ALL = '1\tone\n2\ttwo\n3\tthree'

let task = ''
beforeAll(async () => {
  createApp()
  task = await quietTask()
})

/** The agent reads a file with Claude Code's Read, and Seti ingests the call and its result. */
let reads = 0
async function agentReads(taskId: string, file: string, answer: string): Promise<void> {
  const id = `toolu_file_${String(++reads)}`
  const use = { type: 'assistant', parent_tool_use_id: null, message: { content: [] as object[] } }
  use.message.content.push({ type: 'tool_use', id, name: 'Read', input: { file_path: file } })
  const result = {
    type: 'user',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: answer }] },
  }
  for (const payload of [use, result] as unknown as ClaudeMessage[]) {
    await nodeLink.journal(taskId, { type: 'message', runtime: 'claude', payload })
  }
}

async function recorded(file: string, text = READ_ALL, input: object = {}) {
  const ask = fileAsk(claudeToolCall('call-1', 'Read', { file_path: file, ...input }))
  if (ask === null) {
    return null
  }
  const items = await fileItems(task, ask, text).catch(() => [])
  return items.map((item) => ({ ref: item.ref, permalink: item.permalink, text: itemText(text, item.spans) }))
}

describe('file reads in a GitHub clone', () => {
  it('records a pushed, unchanged file at its commit, its text without line numbers', async () => {
    const { dir, sha } = clone()
    expect(await recorded(path.join(dir, 'docs', 'a.md'))).toEqual([
      {
        ref: `file:acme/notes:docs/a.md@${sha}`,
        permalink: `https://github.com/acme/notes/blob/${sha}/docs/a.md`,
        text: 'one\ntwo\nthree',
      },
    ])
  })

  it('matches a blob link by its short hash and verifies a quote from the lines read', async () => {
    const { dir, sha } = clone()
    const reader = await quietTask()
    await agentReads(reader, path.join(dir, 'docs', 'a.md'), '1\tthe rollout starts\n2\ton Monday at nine')
    const blob = `https://github.com/acme/notes/blob/${sha.slice(0, 7)}/docs/a.md#L1-L2`
    const [hit, miss] = await matchSources(reader, [
      { href: blob, quote: 'the rollout starts on Monday' },
      { href: `https://github.com/acme/notes/blob/${'b'.repeat(40)}/docs/a.md`, quote: null },
    ])
    expect(hit).toMatchObject({ verified: true, unread: false, source: { kind: 'file', container: 'acme/notes' } })
    expect(miss).toMatchObject({ source: null, unread: false })
  })

  it('names a file by its path in a lookup, and a local copy as one', async () => {
    const { dir, sha } = clone()
    fs.copyFileSync(path.join(dir, 'docs', 'a.md'), path.join(dir, 'docs', 'b.md'))
    const reader = await quietTask()
    await agentReads(reader, path.join(dir, 'docs', 'b.md'), '1\tone')
    await agentReads(reader, path.join(dir, 'docs', 'a.md'), '1\tone')
    const { items } = await lookupSources(reader, { kind: 'file', limit: 10 })
    expect(items.map((item) => item.place)).toEqual(['acme/notes/docs/a.md', 'acme/notes/docs/b.md (local file)'])
    expect(items[0]?.permalink).toBe(`https://github.com/acme/notes/blob/${sha}/docs/a.md`)
  })

  it('links the lines a partial read showed', async () => {
    const { dir, sha } = clone()
    const found = await recorded(path.join(dir, 'docs', 'a.md'), '2\ttwo\n3\tthree', { offset: 2, limit: 2 })
    expect(found?.[0]?.permalink).toBe(`https://github.com/acme/notes/blob/${sha}/docs/a.md#L2-L3`)
  })

  it.each([
    [
      'a changed file',
      (dir: string) => {
        fs.appendFileSync(path.join(dir, 'docs', 'a.md'), 'four\n')
      },
    ],
    [
      'an untracked file',
      (dir: string) => {
        fs.copyFileSync(path.join(dir, 'docs', 'a.md'), path.join(dir, 'docs', 'b.md'))
      },
    ],
    ['an unpushed commit', (dir: string) => git(dir, 'commit', '-q', '--allow-empty', '-m', 'later')],
  ])('records %s as a local copy with no permalink', async (name, change) => {
    const { dir } = clone()
    change(dir)
    const file = name === 'an untracked file' ? 'b.md' : 'a.md'
    expect(await recorded(path.join(dir, 'docs', file))).toEqual([
      { ref: `file:acme/notes:docs/${file}`, permalink: '', text: 'one\ntwo\nthree' },
    ])
  })

  it.each([
    ['a clone of another host', () => path.join(clone('https://git.example.com/acme/notes.git').dir, 'docs', 'a.md')],
    ['a clone with no origin', () => path.join(clone('').dir, 'docs', 'a.md')],
    ['a folder outside any clone', () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-bare-')), 'a.md')],
    [
      'a link out of the clone',
      () => {
        const { dir } = clone()
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-out-'))
        fs.writeFileSync(path.join(outside, 'secret.md'), 'x')
        fs.symlinkSync(path.join(outside, 'secret.md'), path.join(dir, 'docs', 'link.md'))
        return path.join(dir, 'docs', 'link.md')
      },
    ],
  ])('records nothing for %s', async (_name, file) => {
    expect(await recorded(file())).toEqual([])
  })

  it('records a link inside the clone under the file it points at', async () => {
    const { dir, sha } = clone()
    fs.symlinkSync(path.join(dir, 'docs', 'a.md'), path.join(dir, 'alias.md'))
    expect((await recorded(path.join(dir, 'alias.md')))?.[0]?.ref).toBe(`file:acme/notes:docs/a.md@${sha}`)
  })

  it('never runs a clean filter the clone names', async () => {
    const { dir } = clone()
    const marker = path.join(dir, '..', `${path.basename(dir)}-ran`)
    git(dir, 'config', 'filter.x.clean', `touch ${marker}; cat`)
    fs.writeFileSync(path.join(dir, '.gitattributes'), '* filter=x\n')
    fs.writeFileSync(path.join(dir, 'docs', 'a.md'), 'one\ntwo\nthre!\n')
    expect((await recorded(path.join(dir, 'docs', 'a.md')))?.[0]?.permalink).toBe('')
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('reads only absolute paths of one file', () => {
    expect(fileAsk(claudeToolCall('call-1', 'Read', { file_path: 'docs/a.md' }))).toBeNull()
    expect(fileAsk(claudeToolCall('call-1', 'Bash', { command: 'cat /x/a.md' }))).toBeNull()
  })
})

describe('GitHub remotes and blob links', () => {
  it.each([
    ['https://github.com/acme/notes.git', 'acme/notes'],
    ['https://github.com/acme/notes', 'acme/notes'],
    ['git@github.com:acme/notes.git', 'acme/notes'],
    ['ssh://git@github.com/acme/notes.git', 'acme/notes'],
    ['https://github.com.example.com/acme/notes.git', null],
    ['https://user:pw@github.com/acme/notes.git', null],
    ['https://github.com/acme/notes/extra.git', null],
    ['/srv/git/notes.git', null],
  ])('%s is %s', (url, repo) => {
    expect(githubRemote(url)).toBe(repo)
  })

  const sha = 'a'.repeat(40)
  it.each([
    [`https://github.com/Acme/Notes/blob/${sha}/docs/a%20b.md#L2-L3`, `file:acme/notes:docs/a b.md@${sha}`, undefined],
    ['https://github.com/acme/notes/blob/abc1234/docs/a.md', 'file:acme/notes:docs/a.md@abc1234', true],
    ['https://github.com/acme/notes/blob/main/docs/a.md', null, undefined],
    [`https://github.com/acme/notes/blob/${sha}/docs/../a.md`, `file:acme/notes:a.md@${sha}`, undefined],
    [`https://github.com/acme/notes/blob/${sha}/docs/`, null, undefined],
    [`https://github.com/acme/notes/blob/${sha}`, null, undefined],
  ])('%s names %s', (url, ref, prefix) => {
    const found = refOfUrl(url)
    expect(found?.ref ?? null).toBe(ref)
    expect(found?.prefix).toBe(prefix)
  })
})
