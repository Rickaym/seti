import fs from 'node:fs'
import os from 'node:os'
import { Readable } from 'node:stream'
import {
  fileListQuery,
  fileQuery,
  fileRawQuery,
  fileSearchQuery,
  fileUrlTarget,
  recentFilesQuery,
  resolvePathsQuery,
  saveFileInput,
  type FileConflict,
  type FileQuery,
  type FileUrlTarget,
  type ResolvedPath,
} from '@seti/shared'
import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { z } from 'zod'
import { audit } from '../audit.js'
import { parseRange } from '../byte-range.js'
import { tasks } from '../db.js'
import { refuseDelegateSecretFile, searchForReader, textForReader } from '../ea-files.js'
import { eaReadOnly } from '../ea-guard.js'
import { htmlPreviewHeaders, previewBody, wantsHtmlPreview } from '../html-preview.js'
import { HttpError, ok, valid, validJson } from '../http.js'
import { sandboxContext } from '../session-options.js'
import { sandboxPolicy } from '../store/sandbox.js'
import { listDir, recentFiles, resolveLinked, resolvePath, workspaceOwner } from '../task-files-list.js'
import { searchFiles, searchOptions } from '../task-files-search.js'
import {
  FileConflictError,
  fileRules,
  locate,
  openChecked,
  publicRoot,
  readFile,
  saveText,
  stampOf,
  taskRoots,
  type FileContext,
} from '../task-files.js'
import { requireTask } from '../tasks.js'

const KEEPALIVE_MS = 15_000
const WATCH_DEBOUNCE_MS = 200
const DAY_MS = 86_400_000

async function fileContext(id: string): Promise<FileContext> {
  const task = await requireTask(id)
  const rules = fileRules(task.id, await sandboxPolicy.get(), sandboxContext())
  return { task, rules, roots: taskRoots(task, rules) }
}

/**
 * Where a mentioned path lives: in the viewing task's roots, else in any task's workspace,
 * which links to that task's read-only workspace root.
 */
async function resolveAnywhere(files: FileContext | null, raw: string): Promise<ResolvedPath | null> {
  const linked = fileUrlTarget(raw)
  if (linked !== null) {
    return resolveUrl(files, raw, linked)
  }
  const home = os.homedir()
  const own = files === null ? null : resolvePath(files, raw, home)
  const owner = own === null ? workspaceOwner(raw, home) : null
  const task = owner === null || owner === files?.task.id ? undefined : await tasks.get(owner)
  if (own !== null || task === undefined) {
    return own
  }
  const rules = fileRules(task.id, await sandboxPolicy.get(), sandboxContext())
  const roots = taskRoots(task, rules).filter((root) => root.kind === 'workspace')
  const found = resolvePath({ task, rules, roots }, raw, home)
  return found === null ? null : { ...found, task_id: task.id }
}

/** A Files download link names its task and root, so any root of that task can hold it. */
async function resolveUrl(files: FileContext | null, raw: string, link: FileUrlTarget): Promise<ResolvedPath | null> {
  if (files !== null && link.task_id === files.task.id) {
    return resolveLinked(files, raw, link.root, link.path)
  }
  const task = await tasks.get(link.task_id)
  if (task === undefined) {
    return null
  }
  const rules = fileRules(task.id, await sandboxPolicy.get(), sandboxContext())
  const found = resolveLinked({ task, rules, roots: taskRoots(task, rules) }, raw, link.root, link.path)
  return found === null ? null : { ...found, task_id: task.id }
}

/** Types a browser may show in place; the rest only download. */
const INLINE =
  /^(application\/pdf|image\/|audio\/|video\/|text\/(plain|markdown|csv|tab-separated-values|vnd\.mermaid);)/

/** SVG opened on its own could run script on Seti's origin, so it renders sandboxed. */
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox"

const attachment = (name: string) => `attachment; filename*=UTF-8''${encodeURIComponent(name)}`

/** A file's bytes, read through the same checked open as a stream. */
function readWhole(real: string): Buffer {
  const fd = openChecked(real)
  try {
    return fs.readFileSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function serveRaw(c: Context, files: FileContext, query: z.output<typeof fileRawQuery>): Response {
  const at = locate(files, query.root, query.path, { dotfiles: query.dotfiles })
  refuseDelegateSecretFile(at)
  const { meta } = readFile(at, false)
  if (wantsHtmlPreview(meta, query)) {
    const page = htmlPreviewHeaders(meta, c.req.header('sec-fetch-dest'), query.scripts)
    const body = previewBody(readWhole(at.real ?? ''), query.scripts)
    const modified = new Date(meta.mtime).toUTCString()
    return c.body(new Uint8Array(body), 200, {
      ...page,
      'Content-Length': String(body.byteLength),
      'Last-Modified': modified,
    })
  }
  const fd = openChecked(at.real ?? '')
  const size = fs.fstatSync(fd).size
  const range = parseRange(c.req.header('range'), size)
  if (range.kind === 'unsatisfiable') {
    fs.closeSync(fd)
    return c.body(null, 416, { 'Content-Range': `bytes */${String(size)}` })
  }
  const span = range.kind === 'part' ? range : { start: 0, end: size - 1 }
  const inline = !query.download && INLINE.test(meta.content_type)
  const headers: Record<string, string> = {
    'Content-Type': query.download ? 'application/octet-stream' : meta.content_type,
    'Content-Length': String(Math.max(0, span.end - span.start + 1)),
    'Accept-Ranges': 'bytes',
    'Content-Disposition': inline ? 'inline' : attachment(meta.name),
    'Last-Modified': new Date(meta.mtime).toUTCString(),
  }
  if (meta.content_type === 'image/svg+xml') {
    headers['Content-Security-Policy'] = SVG_CSP
  }
  const status = range.kind === 'part' ? 206 : 200
  if (range.kind === 'part') {
    headers['Content-Range'] = `bytes ${String(span.start)}-${String(span.end)}/${String(size)}`
  }
  if (size === 0) {
    fs.closeSync(fd)
    return c.body(null, status, headers)
  }
  const stream = fs.createReadStream('', { fd, start: span.start, end: span.end, autoClose: true })
  return c.body(Readable.toWeb(stream) as ReadableStream<Uint8Array>, status, headers)
}

/** Sends the file's stamp, or null for a folder, each time the folder changes, debounced. */
function watchFile(c: Context, files: FileContext, query: FileQuery) {
  const at = locate(files, query.root, query.path, { dotfiles: query.dotfiles })
  const folder = at.real !== null && fs.statSync(at.real).isDirectory() ? at.real : null
  const stamp = () => (folder === null ? stampOf(files, at, query.dotfiles) : null)
  return streamSSE(c, async (stream) => {
    const state = { pending: false }
    let wake: (() => void) | null = null
    let timer: NodeJS.Timeout | undefined
    const watcher = fs.watch(folder ?? at.parent, { persistent: false }, () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        state.pending = true
        wake?.()
      }, WATCH_DEBOUNCE_MS)
    })
    watcher.on('error', () => {
      stream.abort()
    })
    stream.onAbort(() => {
      clearTimeout(timer)
      watcher.close()
      wake?.()
    })
    await stream.writeSSE({ event: 'ready', data: JSON.stringify(stamp()) })
    while (!stream.aborted) {
      if (!state.pending) {
        await new Promise<void>((resolve) => {
          wake = resolve
          setTimeout(resolve, KEEPALIVE_MS)
        })
        wake = null
      }
      const changed = state.pending
      state.pending = false
      await stream.writeSSE(changed ? { event: 'change', data: JSON.stringify(stamp()) } : { event: 'ping', data: '' })
    }
  })
}

async function save(c: Context, id: string, input: z.output<typeof saveFileInput>) {
  const files = await fileContext(id)
  const at = locate(files, input.root, input.path, { dotfiles: input.dotfiles, missing: true })
  let saved: { created: boolean; bytes: number }
  try {
    saved = saveText(files, at, { text: input.text, baseHash: input.base_hash, dotfiles: input.dotfiles })
  } catch (e) {
    if (e instanceof FileConflictError) {
      const body: FileConflict = { error: { title: 'Conflict', detail: e.message }, current: e.current }
      return c.json(body, 409)
    }
    throw e
  }
  const { task } = files
  await audit.record({
    actor: 'user',
    kind: 'task.file_saved',
    subject_type: 'task',
    subject_id: task.id,
    summary: `${saved.created ? 'Created' : 'Saved'} ${at.rel} in ${at.root.label} of task "${task.title}"`,
    detail: { title: task.title, root: at.root.path, path: at.rel, created: saved.created, bytes: saved.bytes },
  })
  return ok(c, readFile(locate(files, input.root, at.rel, { dotfiles: input.dotfiles }), false).meta)
}

export const taskFileRoutes = new Hono()
  .use('/:id/files/*', eaReadOnly("edit an agent's files"))
  .get('/:id/files/roots', async (c) => {
    const files = await fileContext(c.req.param('id'))
    return ok(c, files.roots.map(publicRoot))
  })
  .get('/:id/files/list', valid('query', fileListQuery), async (c) => {
    const query = c.req.valid('query')
    const files = await fileContext(c.req.param('id'))
    const at = locate(files, query.root, query.path, { dotfiles: query.dotfiles })
    return ok(c, listDir(at, files, query))
  })
  .get('/:id/files/recent', valid('query', recentFilesQuery), async (c) => {
    const query = c.req.valid('query')
    const files = await fileContext(c.req.param('id'))
    const since =
      query.days === undefined ? new Date(files.task.created_at) : new Date(Date.now() - query.days * DAY_MS)
    return ok(c, recentFiles(files, { since, limit: query.limit, setiFiles: query.seti_files }))
  })
  .get('/:id/files/search', valid('query', fileSearchQuery), async (c) => {
    const files = await fileContext(c.req.param('id'))
    return ok(c, searchForReader(await searchFiles(files, c.req.valid('query'), searchOptions(c.req.raw.signal))))
  })
  .get('/:id/files/resolve', valid('query', resolvePathsQuery), async (c) => {
    const files = await fileContext(c.req.param('id'))
    return ok(c, await Promise.all(c.req.valid('query').p.map(async (raw) => resolveAnywhere(files, raw))))
  })
  .get('/:id/files/stat', valid('query', fileQuery), async (c) => {
    const query = c.req.valid('query')
    const files = await fileContext(c.req.param('id'))
    return ok(c, readFile(locate(files, query.root, query.path, query), false).meta)
  })
  .get('/:id/files/text', valid('query', fileQuery), async (c) => {
    const query = c.req.valid('query')
    const files = await fileContext(c.req.param('id'))
    const at = locate(files, query.root, query.path, query)
    refuseDelegateSecretFile(at)
    const { meta, text } = readFile(at, true)
    if (text === null) {
      throw new HttpError(415, `${meta.path} is not a text file the editor opens`)
    }
    return ok(c, { ...meta, text: textForReader(text) })
  })
  .get('/:id/files/raw', valid('query', fileRawQuery), async (c) =>
    serveRaw(c, await fileContext(c.req.param('id')), c.req.valid('query')),
  )
  .get('/:id/files/watch', valid('query', fileQuery), async (c) =>
    watchFile(c, await fileContext(c.req.param('id')), c.req.valid('query')),
  )
  .put('/:id/files/text', validJson(saveFileInput), async (c) => save(c, c.req.param('id'), c.req.valid('json')))

/** Paths in any task's workspace, for views that belong to no one task, such as the group chat. */
export const workspaceFileRoutes = new Hono().get('/resolve', valid('query', resolvePathsQuery), async (c) =>
  ok(c, await Promise.all(c.req.valid('query').p.map(async (raw) => resolveAnywhere(null, raw)))),
)
