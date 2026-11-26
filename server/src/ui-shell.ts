import fs from 'node:fs'
import path from 'node:path'
import type { Handler } from 'hono'

/** The files a page needs whole to start; while a build swaps in, the last complete copy answers. */
type ShellFile = 'index.html' | 'sw.js'

interface Kept {
  stamp: string
  body: string
}

/** The UI build writes its id into index.html; see ui/build/dist-swap.ts. */
const BUILD_META = /<meta name="seti-build" content="([\w-]+)"/

const NOT_BUILT = 'UI not built. Run: pnpm build'

/** A missing file may appear a moment later, as while a build swaps in, so no cache keeps it. */
const UNCACHED = { 'cache-control': 'no-store' }

/** Paths that name a file; a missing one is a 404, never the app shell in its place. */
const FILE_PATH = /^\/assets\/|\.\w+$/

export interface UiShell {
  read: (file: ShellFile) => string | null
  /** The id of the build index.html belongs to; null when none is built or it names none. */
  build: () => string | null
}

/** Reads the shell files of `dist` from disk, keeping the last complete copy of each. */
export function createUiShell(dist: string): UiShell {
  const kept = new Map<ShellFile, Kept>()
  const read = (file: ShellFile): string | null => {
    const last = kept.get(file)
    try {
      const stat = fs.statSync(path.join(dist, file))
      const stamp = `${String(stat.ino)}:${String(stat.mtimeMs)}:${String(stat.size)}`
      if (last?.stamp === stamp) {
        return last.body
      }
      const body = fs.readFileSync(path.join(dist, file), 'utf8')
      if (body === '') {
        return last?.body ?? null
      }
      kept.set(file, { stamp, body })
      return body
    } catch {
      return last?.body ?? null
    }
  }
  return {
    read,
    build: () => {
      const html = read('index.html')
      return html === null ? null : (BUILD_META.exec(html)?.[1] ?? null)
    },
  }
}

/** Answers what the static files did not: the worker and the shell from the last build, else 404. */
export function shellFallback(shell: UiShell): Handler {
  return (c) => {
    if (c.req.path === '/sw.js') {
      const worker = shell.read('sw.js')
      return worker === null
        ? c.text(NOT_BUILT, 503, UNCACHED)
        : c.body(worker, 200, { 'content-type': 'text/javascript; charset=utf-8' })
    }
    if (c.req.path !== '/index.html' && FILE_PATH.test(c.req.path)) {
      return c.text('Not found', 404, UNCACHED)
    }
    const index = shell.read('index.html')
    return index === null ? c.text(NOT_BUILT, 503, UNCACHED) : c.html(index)
  }
}
