import fs from 'node:fs'
import path from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import {
  kindByName,
  type AuditEvent,
  type FileConflict,
  type FileListing,
  type FileMeta,
  type FileRoot,
  type FileText,
  type RecentFiles,
  type ResolvedPath,
} from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { SETI_HOME } from '../config.js'
import { sql, tasks } from '../db.js'
import { auditEvents } from '../store/audit.js'
import { sandboxPolicy } from '../store/sandbox.js'
import { sha256 } from '../task-files.js'
import { EA_AUTH, USER_AUTH } from '../test-auth.js'
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

const scratch = fs.mkdtempSync(path.join(path.dirname(SETI_HOME), 'files-'))
const cwd = path.join(scratch, 'agent')
const extra = path.join(scratch, 'notes')
const outside = path.join(scratch, 'outside')

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

const app = createApp()
const BASE = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006' }
const USER = { ...BASE, ...USER_AUTH }
const EA = { ...BASE, ...EA_AUTH }

async function send(headers: Record<string, string>, method: string, url: string, body?: unknown) {
  return app.request(`/api${url}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function data<T>(res: Response): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { data: T }).data
}

const detail = async (res: Response) => ((await res.json()) as { error: { detail: string } }).error.detail

const write = (file: string, text: string, mtime?: Date) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  if (mtime !== undefined) {
    fs.utimesSync(file, mtime, mtime)
  }
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString()

const TASK = 'files-task'
const get = async (url: string, headers = USER) => send(headers, 'GET', `/tasks/${TASK}/files/${url}`)

const WORKBOOK = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0xff, 0x10])

const hour = (h: number) => new Date(Date.now() - h * 3_600_000)

beforeAll(async () => {
  write(path.join(cwd, 'out', 'sample-welcome.pdf'), '%PDF-1.4\n%fake\n', hour(1))
  write(path.join(cwd, 'out', 'old.txt'), 'old\n', hour(48))
  write(path.join(cwd, 'notes.md'), '# Notes\n', hour(2))
  write(path.join(cwd, 'Zeta.txt'), 'z\n', hour(3))
  write(path.join(cwd, 'alpha.txt'), 'a\n', hour(4))
  write(path.join(cwd, '.env'), 'TOKEN=abc\n')
  write(path.join(cwd, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  write(path.join(cwd, 'secret', 'key.txt'), 'hidden\n')
  write(path.join(cwd, 'certs', 'server.key'), 'glob hidden\n')
  fs.writeFileSync(path.join(cwd, 'blob.bin'), Buffer.from([0, 1, 2, 3, 255]))
  write(path.join(cwd, 'out', 'flow.mmd'), 'graph TD\n  A --> B\n', hour(48))
  write(path.join(cwd, 'out', 'rows.tsv'), 'a\tb\n1\t2\n', hour(48))
  fs.writeFileSync(path.join(cwd, 'out', 'book.xlsx'), WORKBOOK)
  fs.utimesSync(path.join(cwd, 'out', 'book.xlsx'), hour(48), hour(48))
  write(path.join(outside, 'escape.txt'), 'outside\n')
  fs.symlinkSync(path.join(outside, 'escape.txt'), path.join(cwd, 'escape.txt'))
  fs.symlinkSync(outside, path.join(cwd, 'escape-dir'))
  fs.symlinkSync(path.join(cwd, 'notes.md'), path.join(cwd, 'alias.md'))
  write(path.join(extra, 'todo.md'), '- [ ] ship\n')
  write(path.join(workspaceDir(TASK), 'task.md'), '# Task\n')
  write(path.join(SETI_HOME, 'private', 'data.txt'), 'seti data\n')
  await tasks.insert({ id: TASK, title: 'Files', repo_id: null, cwd, worktree: false, pr_urls: [] })
  await sql`UPDATE task SET created_at = ${hour(24).toISOString()} WHERE id = ${TASK}`
  await sql`INSERT INTO task_dir (task_id, dir) VALUES (${TASK}, ${extra}), (${TASK}, ${path.join(SETI_HOME, 'private')})`
  const policy = await sandboxPolicy.get()
  await sandboxPolicy.save({ ...policy, hidden_paths: [path.join(cwd, 'secret'), `${cwd}/**/*.key`] })
})

describe('roots', () => {
  it('offers the working directory, extra directories and the workspace, not Seti data', async () => {
    const roots = await data<FileRoot[]>(await get('roots'))
    expect(roots.map((root) => [root.id.replace(/^dir-\w+$/, 'dir'), root.label, root.exists, root.writable])).toEqual([
      ['cwd', 'agent', true, true],
      ['dir', 'notes', true, true],
      ['dir', 'private', false, true],
      ['workspace', 'Workspace', true, false],
    ])
  })
})

describe('listing', () => {
  it('sorts by recent change by default and by name on request, without dot files', async () => {
    const recent = await data<FileListing>(await get(`list?${q({ root: 'cwd' })}`))
    const names = recent.entries.map((entry) => entry.name)
    const aged = new Set(['notes.md', 'Zeta.txt', 'alpha.txt'])
    expect(names.filter((name) => aged.has(name))).toEqual(['notes.md', 'Zeta.txt', 'alpha.txt'])
    expect(names).not.toContain('.env')
    expect(names).not.toContain('escape.txt')
    expect(names).not.toContain('escape-dir')
    expect(names).not.toContain('secret')
    expect(names).toContain('node_modules')
    const byName = await data<FileListing>(await get(`list?${q({ root: 'cwd', sort: 'name' })}`))
    const files = byName.entries.filter((entry) => entry.type === 'file').map((entry) => entry.name)
    expect(files.indexOf('alpha.txt')).toBeLessThan(files.indexOf('Zeta.txt'))
    expect(byName.entries[0]?.type).toBe('dir')
  })

  it('shows dot files only when asked', async () => {
    const listing = await data<FileListing>(await get(`list?${q({ root: 'cwd', dotfiles: '1' })}`))
    expect(listing.entries.map((entry) => entry.name)).toContain('.env')
  })

  it('browses noise folders when opened explicitly', async () => {
    const listing = await data<FileListing>(await get(`list?${q({ root: 'cwd', path: 'node_modules/dep' })}`))
    expect(listing.entries.map((entry) => entry.name)).toEqual(['index.js'])
  })

  it('lists recent files across roots, newest first, skipping noise and old files', async () => {
    const recent = await data<RecentFiles>(await get('recent'))
    const paths = recent.files.map((file) => `${file.root === 'cwd' ? '' : 'x:'}${file.path}`)
    expect(paths).toContain('x:todo.md')
    expect(paths).toContain('out/sample-welcome.pdf')
    expect(paths).not.toContain('out/old.txt')
    expect(paths).not.toContain('node_modules/dep/index.js')
    expect(paths).not.toContain('.env')
    expect(paths).not.toContain('secret/key.txt')
    expect(paths.indexOf('out/sample-welcome.pdf')).toBeLessThan(paths.indexOf('notes.md'))
    const week = await data<RecentFiles>(await get('recent?days=7&limit=2'))
    expect(week.files).toHaveLength(2)
  })
})

describe('path checks', () => {
  it('refuses traversal and absolute paths', async () => {
    const up = await get(`text?${q({ root: 'cwd', path: '../outside/escape.txt' })}`)
    expect(up.status).toBe(403)
    const absolute = await get(`text?${q({ root: 'cwd', path: path.join(outside, 'escape.txt') })}`)
    expect(absolute.status).toBe(400)
  })

  it('refuses symlinks that leave the root and follows those that stay', async () => {
    const escape = await get(`text?${q({ root: 'cwd', path: 'escape.txt' })}`)
    expect(escape.status).toBe(403)
    expect(await detail(escape)).toContain('leads outside its root')
    expect((await get(`list?${q({ root: 'cwd', path: 'escape-dir' })}`)).status).toBe(403)
    const alias = await data<FileText>(await get(`text?${q({ root: 'cwd', path: 'alias.md' })}`))
    expect(alias.text).toBe('# Notes\n')
  })

  it('never serves hidden paths, dot files opted in or not', async () => {
    for (const file of ['secret/key.txt', 'certs/server.key']) {
      const res = await get(`raw?${q({ root: 'cwd', path: file, dotfiles: '1' })}`)
      expect(res.status).toBe(403)
      expect(await detail(res)).toContain('hidden path')
    }
  })

  it('serves dot files only with the opt-in flag', async () => {
    const refused = await get(`text?${q({ root: 'cwd', path: '.env' })}`)
    expect(refused.status).toBe(403)
    const opted = await data<FileText>(await get(`text?${q({ root: 'cwd', path: '.env', dotfiles: '1' })}`))
    expect(opted.text).toBe('TOKEN=abc\n')
  })

  it("refuses Seti's own data, even as a directory the task names", async () => {
    const res = await get(`list?${q({ root: 'workspace', path: '../../private' })}`)
    expect(res.status).toBe(403)
    const roots = await data<FileRoot[]>(await get('roots'))
    const privateRoot = roots.find((root) => root.label === 'private')
    expect((await get(`list?${q({ root: privateRoot?.id ?? '' })}`)).status).toBe(404)
  })
})

describe('reading', () => {
  it('reads text with its hash and serves raw files with their type and ranges', async () => {
    const note = await data<FileText>(await get(`text?${q({ root: 'cwd', path: 'notes.md' })}`))
    expect(note).toMatchObject({ kind: 'markdown', hash: sha256('# Notes\n'), writable: true })
    const pdf = await get(`raw?${q({ root: 'cwd', path: 'out/sample-welcome.pdf' })}`)
    expect(pdf.headers.get('content-type')).toBe('application/pdf')
    expect(pdf.headers.get('content-disposition')).toBe('inline')
    expect(await pdf.text()).toBe('%PDF-1.4\n%fake\n')
    const part = await send(
      { ...USER, range: 'bytes=1-3' },
      'GET',
      `/tasks/${TASK}/files/raw?${q({ root: 'cwd', path: 'out/sample-welcome.pdf' })}`,
    )
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 1-3/15')
    expect(await part.text()).toBe('PDF')
  })

  it('treats binary content as binary and downloads it', async () => {
    const meta = await data<FileMeta>(await get(`stat?${q({ root: 'cwd', path: 'blob.bin' })}`))
    expect(meta).toMatchObject({ kind: 'binary', hash: null, writable: false })
    expect((await get(`text?${q({ root: 'cwd', path: 'blob.bin' })}`)).status).toBe(415)
    const raw = await get(`raw?${q({ root: 'cwd', path: 'notes.md', download: '1' })}`)
    expect(raw.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''notes.md")
  })

  it('names diagrams and tables as text and serves workbooks with their own type', async () => {
    const diagram = await data<FileText>(await get(`text?${q({ root: 'cwd', path: 'out/flow.mmd' })}`))
    expect(diagram).toMatchObject({ kind: 'mermaid', content_type: 'text/vnd.mermaid; charset=utf-8', writable: true })
    const table = await data<FileMeta>(await get(`stat?${q({ root: 'cwd', path: 'out/rows.tsv' })}`))
    expect(table).toMatchObject({ kind: 'csv', content_type: 'text/tab-separated-values; charset=utf-8' })
    const rows = await get(`raw?${q({ root: 'cwd', path: 'out/rows.tsv' })}`)
    expect(rows.headers.get('content-disposition')).toBe('inline')
    const book = await data<FileMeta>(await get(`stat?${q({ root: 'cwd', path: 'out/book.xlsx' })}`))
    expect(book).toMatchObject({ kind: 'spreadsheet', hash: null, writable: false })
    const raw = await get(`raw?${q({ root: 'cwd', path: 'out/book.xlsx' })}`)
    expect(raw.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(raw.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''book.xlsx")
    expect(Buffer.from(await raw.arrayBuffer())).toEqual(WORKBOOK)
    const download = await get(`raw?${q({ root: 'cwd', path: 'out/book.xlsx', download: '1' })}`)
    expect(download.headers.get('content-type')).toBe('application/octet-stream')
  })

  it('names audio, video and image files by their extension', () => {
    const kinds = (names: string[]) => names.map(kindByName)
    expect(kinds(['a.mp3', 'a.WAV', 'a.ogg', 'a.oga', 'a.opus', 'a.m4a', 'a.aac', 'a.flac'])).toEqual(
      Array.from({ length: 8 }, () => 'audio'),
    )
    expect(kinds(['a.mp4', 'a.m4v', 'a.webm', 'a.MOV', 'a.ogv'])).toEqual(Array.from({ length: 5 }, () => 'video'))
    expect(kinds(['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'a.avif', 'a.svg', 'a.bmp', 'a.ico'])).toEqual(
      Array.from({ length: 9 }, () => 'image'),
    )
    expect(kinds(['mp3', '.wav', 'a.mp3.txt'])).toEqual([null, null, null])
  })

  it('serves media inline with its type and in ranges, and svg sandboxed', async () => {
    const media = path.join(scratch, 'media')
    fs.mkdirSync(media)
    fs.writeFileSync(path.join(media, 'take.wav'), Buffer.alloc(2048, 1))
    fs.writeFileSync(path.join(media, 'clip.webm'), Buffer.alloc(1000, 2))
    fs.writeFileSync(path.join(media, 'clip.mov'), Buffer.alloc(10, 3))
    fs.writeFileSync(path.join(media, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')
    await sql`INSERT INTO task_dir (task_id, dir) VALUES (${TASK}, ${media})`
    const roots = await data<FileRoot[]>(await get('roots'))
    const root = roots.find((entry) => entry.label === 'media')?.id ?? ''
    const raw = async (file: string, range?: string) =>
      send(
        range === undefined ? USER : { ...USER, range },
        'GET',
        `/tasks/${TASK}/files/raw?${q({ root, path: file })}`,
      )

    const audio = await data<FileMeta>(await get(`stat?${q({ root, path: 'take.wav' })}`))
    expect(audio).toMatchObject({ kind: 'audio', content_type: 'audio/wav' })
    const video = await raw('clip.webm')
    expect(video.status).toBe(200)
    expect(video.headers.get('content-type')).toBe('video/webm')
    expect(video.headers.get('content-disposition')).toBe('inline')
    expect(video.headers.get('accept-ranges')).toBe('bytes')
    expect(video.headers.get('content-length')).toBe('1000')
    expect((await raw('clip.mov')).headers.get('content-type')).toBe('video/quicktime')

    const tail = await raw('take.wav', 'bytes=-500')
    expect(tail.status).toBe(206)
    expect(tail.headers.get('content-range')).toBe('bytes 1548-2047/2048')
    expect(tail.headers.get('content-length')).toBe('500')
    expect((await tail.arrayBuffer()).byteLength).toBe(500)
    const rest = await raw('take.wav', 'bytes=100-')
    expect(rest.headers.get('content-range')).toBe('bytes 100-2047/2048')
    const past = await raw('take.wav', 'bytes=4096-')
    expect(past.status).toBe(416)
    expect(past.headers.get('content-range')).toBe('bytes */2048')
    const several = await raw('take.wav', 'bytes=0-1,4-5')
    expect(several.status).toBe(200)
    expect((await several.arrayBuffer()).byteLength).toBe(2048)

    const svg = await raw('logo.svg')
    expect(svg.headers.get('content-type')).toBe('image/svg+xml')
    expect(svg.headers.get('content-security-policy')).toContain('sandbox')
    expect(svg.headers.get('x-content-type-options')).toBe('nosniff')
    expect(svg.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('resolves paths an agent mentions, relative or absolute, and nothing else', async () => {
    const inWorkspace = path.join(workspaceDir(TASK), 'task.md')
    const params = [
      'out/sample-welcome.pdf',
      path.join(extra, 'todo.md'),
      inWorkspace,
      'missing.md',
      '.env',
      'escape.txt',
    ]
    const query = new URLSearchParams(params.map((p): [string, string] => ['p', p])).toString()
    const found = await data<(ResolvedPath | null)[]>(await get(`resolve?${query}`))
    const pdf = fs.statSync(path.join(cwd, 'out', 'sample-welcome.pdf'))
    expect(found[0]).toEqual({
      input: 'out/sample-welcome.pdf',
      root: 'cwd',
      path: 'out/sample-welcome.pdf',
      type: 'file',
      size: pdf.size,
      mtime: pdf.mtime.toISOString(),
    })
    expect(found[1]).toMatchObject({ path: 'todo.md', type: 'file' })
    expect(found[2]).toMatchObject({ root: 'workspace', path: 'task.md', type: 'file' })
    expect(found.slice(3)).toEqual([null, null, null])
  })

  it('resolves Files download links on any host, in any root of the task they name', async () => {
    const raw = (task: string, root: string, file: string) => `/api/tasks/${task}/files/raw?${q({ root, path: file })}`
    const params = [
      `https://seti.example.com${raw(TASK, 'cwd', 'out/sample-welcome.pdf')}&download=1`,
      raw(TASK, 'workspace', 'task.md'),
      `http://127.0.0.1:3006${raw(TASK, 'cwd', 'missing.md')}`,
      raw('no-such-task', 'cwd', 'out/sample-welcome.pdf'),
      `https://seti.example.com${raw(TASK, 'cwd', 'out')}`,
    ]
    const query = new URLSearchParams(params.map((p): [string, string] => ['p', p])).toString()
    const found = await data<(ResolvedPath | null)[]>(await get(`resolve?${query}`))
    expect(found[0]).toMatchObject({ input: params[0], root: 'cwd', path: 'out/sample-welcome.pdf', type: 'file' })
    expect(found[0]?.task_id).toBeUndefined()
    expect(found[1]).toMatchObject({ root: 'workspace', path: 'task.md', type: 'file' })
    expect(found.slice(2, 4)).toEqual([null, null])
    expect(found[4]).toEqual({ input: params[4], root: 'cwd', path: 'out', type: 'dir' })

    const anywhere = await send(USER, 'GET', `/files/resolve?${q({ p: raw(TASK, 'cwd', 'out/sample-welcome.pdf') })}`)
    expect(await data<(ResolvedPath | null)[]>(anywhere)).toEqual([
      expect.objectContaining({ root: 'cwd', path: 'out/sample-welcome.pdf', task_id: TASK }),
    ])
  })
})

describe('saving', () => {
  const put = async (body: Record<string, unknown>, headers = USER) =>
    send(headers, 'PUT', `/tasks/${TASK}/files/text`, { root: 'cwd', ...body })

  it('creates and saves text files against the hash the editor loaded, and audits without content', async () => {
    const created = await data<FileMeta>(await put({ path: 'drafts/plan.md', text: 'v1\n', base_hash: null }))
    expect(created.hash).toBe(sha256('v1\n'))
    expect((await put({ path: 'drafts/plan.md', text: 'again\n', base_hash: null })).status).toBe(409)
    const saved = await data<FileMeta>(await put({ path: 'drafts/plan.md', text: 'v2\n', base_hash: created.hash }))
    expect(fs.readFileSync(path.join(cwd, 'drafts', 'plan.md'), 'utf8')).toBe('v2\n')
    expect(saved.hash).toBe(sha256('v2\n'))

    fs.writeFileSync(path.join(cwd, 'drafts', 'plan.md'), 'agent edit\n')
    const stale = await put({ path: 'drafts/plan.md', text: 'v3\n', base_hash: saved.hash })
    expect(stale.status).toBe(409)
    const conflict = (await stale.json()) as FileConflict
    expect(conflict.current).toMatchObject({ exists: true, hash: sha256('agent edit\n') })
    expect(fs.readFileSync(path.join(cwd, 'drafts', 'plan.md'), 'utf8')).toBe('agent edit\n')

    const events = await auditEvents.page({ kind: 'task.file_saved', limit: 10 })
    const saves = events.events.filter((event: AuditEvent) => event.subject_id === TASK)
    expect(saves.map((event) => event.detail.created)).toEqual([false, true])
    expect(saves[0]?.detail).toMatchObject({ path: 'drafts/plan.md', root: cwd })
    expect(JSON.stringify(saves)).not.toContain('v2')
  })

  it('keeps the mode of the file it replaces', async () => {
    const file = path.join(cwd, 'run.sh')
    write(file, 'echo hi\n')
    fs.chmodSync(file, 0o750)
    await data(await put({ path: 'run.sh', text: 'echo bye\n', base_hash: sha256('echo hi\n') }))
    expect(fs.statSync(file).mode & 0o777).toBe(0o750)
  })

  it('refuses hidden paths, dot files, escapes and the read-only workspace', async () => {
    expect((await put({ path: 'secret/new.txt', text: 'x', base_hash: null })).status).toBe(403)
    expect((await put({ path: '.env', text: 'x', base_hash: sha256('TOKEN=abc\n') })).status).toBe(403)
    expect((await put({ path: 'escape.txt', text: 'x', base_hash: sha256('outside\n') })).status).toBe(403)
    expect((await put({ path: 'escape-dir/new.txt', text: 'x', base_hash: null })).status).toBe(403)
    expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false)
    const workspace = await put({ root: 'workspace', path: 'task.md', text: 'x', base_hash: sha256('# Task\n') })
    expect(workspace.status).toBe(403)
    expect((await put({ path: 'blob.bin', text: 'x', base_hash: 'nope' })).status).toBe(415)
  })

  it('lets the EA read but not write', async () => {
    const listing = await data<FileListing>(await get(`list?${q({ root: 'cwd' })}`, EA))
    expect(listing.entries.length).toBeGreaterThan(0)
    const res = await put({ path: 'ea.md', text: 'x', base_hash: null }, EA)
    expect(res.status).toBe(403)
    expect(fs.existsSync(path.join(cwd, 'ea.md'))).toBe(false)
  })

  it('keeps an archived agent read-only', async () => {
    await sql`UPDATE task SET archived_at = ${new Date().toISOString()} WHERE id = ${TASK}`
    try {
      expect((await get(`text?${q({ root: 'cwd', path: 'notes.md' })}`)).status).toBe(200)
      expect((await put({ path: 'archived.md', text: 'x', base_hash: null })).status).toBe(409)
    } finally {
      await sql`UPDATE task SET archived_at = NULL WHERE id = ${TASK}`
    }
  })
})

describe('watching', () => {
  it('announces a change to the open file', async () => {
    const res = await get(`watch?${q({ root: 'cwd', path: 'notes.md' })}`)
    const reader = res.body?.getReader()
    expect(reader).toBeDefined()
    const decoder = new TextDecoder()
    let seen = ''
    const until = async (needle: string) => {
      while (!seen.includes(needle)) {
        const chunk = await reader?.read()
        if (chunk === undefined || chunk.done) {
          throw new Error(`stream ended before ${needle}`)
        }
        seen += decoder.decode(chunk.value as Uint8Array)
      }
    }
    await until('event: ready')
    fs.writeFileSync(path.join(cwd, 'notes.md'), '# Notes\nagent line\n')
    await until('event: change')
    expect(seen).toContain(sha256('# Notes\nagent line\n'))
    await reader?.cancel()
  })
})
