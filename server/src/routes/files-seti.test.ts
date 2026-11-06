import fs from 'node:fs'
import path from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import type { FileListing, FileNameHit, FileSearch, FileTextHit, RecentFiles } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { binaryPath } from '../binaries.js'
import { SETI_HOME } from '../config.js'
import { sql, tasks } from '../db.js'
import { USER_AUTH } from '../test-auth.js'
import { workspaceDir } from '../workspace/dir.js'

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

const TASK = 'files-seti-task'
const scratch = fs.mkdtempSync(path.join(path.dirname(SETI_HOME), 'files-seti-'))
const workspace = workspaceDir(TASK)
const cwd = path.join(workspace, 'eng-lead')
const linked = path.join(scratch, 'loadtest-link')

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

const app = createApp()
const HEADERS = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006', ...USER_AUTH }

async function data<T>(url: string): Promise<T> {
  const res = await app.request(`/api/tasks/${TASK}/files/${url}`, { headers: HEADERS })
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { data: T }).data
}

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const SETI_WRITTEN = ['chat.md', 'members.md', 'task.md', 'packs/review.md', 'context/CLAUDE.md']

let linkRoot = ''

beforeAll(async () => {
  for (const rel of SETI_WRITTEN) {
    write(path.join(workspace, rel), `# ${rel} beacon\n`)
  }
  write(path.join(workspace, 'report.md'), '# Agent report beacon\n')
  write(path.join(cwd, 'ops.log'), 'deploy beacon\n')
  write(path.join(cwd, 'cu-pending.md'), '- pending beacon\n')
  write(path.join(cwd, 'loadtest', 'drill.md'), '# Drill beacon\n')
  fs.symlinkSync(path.join(workspace, 'members.md'), path.join(cwd, 'members-link.md'))
  fs.symlinkSync(path.join(cwd, 'loadtest'), linked)
  await tasks.insert({ id: TASK, title: 'Seti files', repo_id: null, cwd, worktree: false, pr_urls: [] })
  await sql`UPDATE task SET created_at = ${new Date(Date.now() - 3_600_000).toISOString()} WHERE id = ${TASK}`
  await sql`INSERT INTO task_dir (task_id, dir) VALUES (${TASK}, ${linked})`
  const roots = await data<{ id: string; path: string }[]>('roots')
  linkRoot = roots.find((root) => root.path === linked)?.id ?? ''
})

const where = (file: { root: string; path: string }) => `${file.root === linkRoot ? 'link' : file.root}:${file.path}`

const sorted = (list: readonly string[]) => list.toSorted((a, b) => a.localeCompare(b, 'en'))

describe("Seti's own workspace files", () => {
  it('stay out of the recent files unless asked for, while agent files show', async () => {
    const shown = (await data<RecentFiles>('recent')).files.map(where)
    expect(sorted(shown)).toEqual(['cwd:cu-pending.md', 'cwd:ops.log', 'link:drill.md', 'workspace:report.md'])
    const all = (await data<RecentFiles>('recent?seti_files=1')).files.map(where)
    expect(all).toEqual(expect.arrayContaining(SETI_WRITTEN.map((rel) => `workspace:${rel}`)))
    expect(all).toContain('workspace:report.md')
  })

  it('stay out of folder listings unless asked for, also through a link, but show inside their folders', async () => {
    const top = await data<FileListing>('list?root=workspace')
    expect(sorted(top.entries.map((entry) => entry.name))).toEqual(['eng-lead', 'report.md'])
    const own = await data<FileListing>('list?root=cwd')
    expect(own.entries.map((entry) => entry.name)).not.toContain('members-link.md')
    const all = await data<FileListing>('list?root=workspace&seti_files=1')
    expect(all.entries.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['chat.md', 'members.md', 'task.md', 'packs', 'context']),
    )
    const packs = await data<FileListing>('list?root=workspace&path=packs')
    expect(packs.entries.map((entry) => entry.name)).toEqual(['review.md'])
  })
})

const RG = binaryPath('rg')

describe('nested roots', () => {
  it('show each recent file once, under the innermost root that holds it', async () => {
    const all = (await data<RecentFiles>('recent?seti_files=1')).files.map(where)
    expect(all.filter((file) => file.endsWith('ops.log'))).toEqual(['cwd:ops.log'])
    expect(all.filter((file) => file.endsWith('drill.md'))).toEqual(['link:drill.md'])
    expect(new Set(all).size).toBe(all.length)
  })

  it.skipIf(RG === null)('show each search hit once, by name and by text, and Seti files only when asked', async () => {
    const byName = await data<FileSearch>('search?q=drill')
    expect((byName.hits as FileNameHit[]).map(where)).toEqual(['link:drill.md'])
    const byText = await data<FileSearch>('search?q=beacon&mode=text')
    const lines = (byText.hits as FileTextHit[]).map(where)
    expect(sorted(lines)).toEqual(['cwd:cu-pending.md', 'cwd:ops.log', 'link:drill.md', 'workspace:report.md'])
    const withSeti = await data<FileSearch>('search?q=members&seti_files=1')
    expect((withSeti.hits as FileNameHit[]).map(where)).toContain('workspace:members.md')
  })
})
