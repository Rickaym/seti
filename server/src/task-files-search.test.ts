import fs from 'node:fs'
import path from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import { fileSearchQuery, type FileNameHit, type FileSearch, type FileTextHit } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { binaryPath } from './binaries.js'
import { SETI_HOME } from './config.js'
import { sql, tasks } from './db.js'
import { matchPath } from './fuzzy-path.js'
import { sandboxContext } from './session-options.js'
import { sandboxPolicy } from './store/sandbox.js'
import { searchFiles, type SearchOptions } from './task-files-search.js'
import { fileRules, taskRoots, type FileContext } from './task-files.js'
import { requireTask } from './tasks.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'
import { workspaceDir } from './workspace/dir.js'

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof Sdk>()),
  query: (_params: { prompt: unknown; options?: Options }) => {
    const session = (async function* () {
      await Promise.resolve()
      yield* []
    })()
    return Object.assign(session, { close: () => undefined })
  },
}))

const scratch = fs.mkdtempSync(path.join(path.dirname(SETI_HOME), 'search-'))
const cwd = path.join(scratch, 'agent')
const extra = path.join(scratch, 'notes')
const outside = path.join(scratch, 'outside')
const slowRg = path.join(scratch, 'slow-rg')
const RG = binaryPath('rg')
const BULK = 250

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

const app = createApp()
const BASE = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006' }
const TASK = 'search-task'

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

async function search(params: Record<string, string>, auth: Record<string, string> = USER_AUTH) {
  const query = new URLSearchParams(params).toString()
  return app.request(`/api/tasks/${TASK}/files/search?${query}`, { headers: { ...BASE, ...auth } })
}

async function found(params: Record<string, string>): Promise<FileSearch> {
  const res = await search(params)
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { data: FileSearch }).data
}

const names = (result: FileSearch) => (result.hits as FileNameHit[]).map((hit) => hit.path)
const lines = (result: FileSearch) => (result.hits as FileTextHit[]).map((hit) => `${hit.path}:${String(hit.line)}`)

async function context(): Promise<FileContext> {
  const task = await requireTask(TASK)
  const rules = fileRules(task.id, await sandboxPolicy.get(), sandboxContext())
  return { task, rules, roots: taskRoots(task, rules) }
}

const direct = async (params: Record<string, string>, options: SearchOptions) =>
  searchFiles(await context(), fileSearchQuery.parse(params), options)

beforeAll(async () => {
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true })
  write(path.join(cwd, '.gitignore'), 'ignored/\n')
  write(path.join(cwd, 'src', 'search-panel.tsx'), 'first\nconst needle = 1\nneedle again\n')
  write(path.join(cwd, 'ignored', 'needle.txt'), 'needle\n')
  write(path.join(cwd, 'node_modules', 'dep', 'needle.js'), 'needle\n')
  write(path.join(cwd, 'secret', 'needle.txt'), 'needle\n')
  write(path.join(cwd, 'certs', 'needle.key'), 'needle\n')
  write(path.join(cwd, '.env'), 'NEEDLE=abc\n')
  write(path.join(outside, 'needle-escape.txt'), 'needle outside\n')
  fs.symlinkSync(path.join(outside, 'needle-escape.txt'), path.join(cwd, 'needle-link.txt'))
  fs.symlinkSync(outside, path.join(cwd, 'escape-dir'))
  write(path.join(extra, 'needle-notes.md'), 'a needle in the notes\n')
  write(path.join(workspaceDir(TASK), 'task.md'), '# Task\n')
  write(path.join(SETI_HOME, 'search-private', 'needle.txt'), 'needle\n')
  for (let i = 0; i < BULK; i++) {
    write(path.join(cwd, 'bulk', `hay-${String(i)}.txt`), 'hay haystack\n')
  }
  write(slowRg, '#!/bin/sh\nexec sleep 5\n')
  fs.chmodSync(slowRg, 0o700)
  await tasks.insert({ id: TASK, title: 'Search', repo_id: null, cwd, worktree: false, pr_urls: [] })
  const privateDir = path.join(SETI_HOME, 'search-private')
  await sql`INSERT INTO task_dir (task_id, dir) VALUES (${TASK}, ${extra}), (${TASK}, ${privateDir})`
  const policy = await sandboxPolicy.get()
  await sandboxPolicy.save({ ...policy, hidden_paths: [path.join(cwd, 'secret'), `${cwd}/**/*.key`] })
})

describe('fuzzy path match', () => {
  it('ranks the query in the file name over scattered letters, and marks the matched characters', () => {
    expect(matchPath('src/search-panel.tsx', 'panel')?.marks).toEqual([11, 12, 13, 14, 15])
    expect(matchPath('src/search-panel.tsx', 'spt')?.marks).toEqual([4, 11, 17])
    expect(matchPath('src/search-panel.tsx', 'xyz')).toBeNull()
    const inName = matchPath('a/panel.ts', 'panel')?.score ?? 0
    const inFolder = matchPath('panel/a.ts', 'panel')?.score ?? 0
    const scattered = matchPath('p/a/n/e/l.ts', 'panel')?.score ?? 0
    expect(inName).toBeGreaterThan(inFolder)
    expect(inFolder).toBeGreaterThan(scattered)
  })
})

describe.skipIf(RG === null)('name search with ripgrep', () => {
  it('finds files and folders across roots and marks the match', async () => {
    const result = await found({ q: 'needle' })
    expect(result.mode).toBe('name')
    expect(names(result).toSorted((a, b) => a.localeCompare(b, 'en'))).toEqual(['needle-notes.md'])
    const panel = await found({ q: 'srchpnl' })
    expect(panel.hits[0]).toMatchObject({ root: 'cwd', path: 'src/search-panel.tsx', type: 'file' })
    const folder = await found({ q: 'src' })
    expect(folder.hits[0]).toMatchObject({ path: 'src', type: 'dir', marks: [0, 1, 2] })
  })

  it('leaves out ignored, noise, hidden, dot, Seti and escaping paths', async () => {
    const all = names(await found({ q: 'e', limit: '200' }))
    expect(all).toContain('src/search-panel.tsx')
    for (const refused of ['ignored', 'node_modules', 'secret', 'certs', '.env', 'needle-link.txt', 'escape-dir']) {
      expect(all.filter((name) => name.startsWith(refused))).toEqual([])
    }
    expect(all.filter((name) => name.includes('needle-escape'))).toEqual([])
  })

  it('takes dot files when asked, and hidden paths still not', async () => {
    const dotted = names(await found({ q: 'env', dotfiles: '1' }))
    expect(dotted).toContain('.env')
    const keys = names(await found({ q: 'needle', dotfiles: '1' }))
    expect(keys.filter((name) => name.startsWith('secret') || name.startsWith('certs'))).toEqual([])
  })

  it('caps the hits and says there are more', async () => {
    const capped = await found({ q: 'hay' })
    expect(capped.hits).toHaveLength(200)
    expect(capped.truncated).toBe(true)
    const few = await found({ q: 'hay', limit: '5' })
    expect(few.hits).toHaveLength(5)
    const one = await found({ q: 'search-panel' })
    expect(one.truncated).toBe(false)
  })
})

describe.skipIf(RG === null)('text search', () => {
  it('finds lines with their number and marks, in served files only', async () => {
    const result = await found({ q: 'needle', mode: 'text' })
    expect(lines(result).toSorted((a, b) => a.localeCompare(b, 'en'))).toEqual([
      'needle-notes.md:1',
      'src/search-panel.tsx:2',
      'src/search-panel.tsx:3',
    ])
    const hit = (result.hits as FileTextHit[]).find((h) => h.line === 2)
    expect(hit).toMatchObject({ text: 'const needle = 1', marks: [[6, 12]] })
  })

  it('reads the query literally unless regex is on, and reports a bad expression', async () => {
    expect(lines(await found({ q: 'need.e', mode: 'text' }))).toEqual([])
    expect(lines(await found({ q: 'need.e', mode: 'text', regex: '1' }))).toHaveLength(3)
    expect(lines(await found({ q: '-e', mode: 'text' }))).toEqual([])
    const bad = await search({ q: '(', mode: 'text', regex: '1' })
    expect(bad.status).toBe(400)
  })

  it('caps the hits', async () => {
    const capped = await found({ q: 'hay', mode: 'text', limit: '20' })
    expect(capped.hits).toHaveLength(20)
    expect(capped.truncated).toBe(true)
  })

  it('lets the EA search, and refuses an empty query', async () => {
    const res = await search({ q: 'needle', mode: 'text' }, EA_AUTH)
    expect(res.status).toBe(200)
    expect((await search({ q: '  ' })).status).toBe(400)
  })
})

describe('limits and fallbacks', () => {
  it('stops a slow search at its timeout and says it is partial', async () => {
    const started = Date.now()
    const result = await direct({ q: 'needle', mode: 'text' }, { rg: slowRg, timeoutMs: 100 })
    expect(result).toMatchObject({ hits: [], partial: true })
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('walks the roots by name without ripgrep, under the same rules', async () => {
    const result = await direct({ q: 'needle' }, { rg: null, timeoutMs: 5_000 })
    const all = (result.hits as FileNameHit[]).map((hit) => hit.path)
    expect(all).toContain('needle-notes.md')
    expect(all.filter((name) => /^(node_modules|secret|certs|needle-link|escape-dir)/.test(name))).toEqual([])
    await expect(direct({ q: 'needle', mode: 'text' }, { rg: null, timeoutMs: 5_000 })).rejects.toThrow('ripgrep')
  })
})
