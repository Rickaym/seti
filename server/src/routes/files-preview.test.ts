import fs from 'node:fs'
import path from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import { HTML_PREVIEW_MAX, pageExtensions } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { SETI_HOME } from '../config.js'
import { tasks } from '../db.js'
import { modHost } from '../mods/bundled.js'
import { USER_AUTH } from '../test-auth.js'

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

const TASK = 'files-preview-task'
const scratch = fs.mkdtempSync(path.join(path.dirname(SETI_HOME), 'files-preview-'))
const app = createApp()
const HEADERS = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006', ...USER_AUTH }
const FRAME = { ...HEADERS, 'sec-fetch-dest': 'iframe' }
const PAGE = '<!doctype html><p id="out"></p><script>out.textContent = "ran"</script>\n'

const policy = (script: string, sandbox: string) =>
  `default-src 'none'; script-src ${script}; style-src 'unsafe-inline' data:; ` +
  "img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; " +
  `form-action 'none'; base-uri 'none'; frame-ancestors 'self'; ${sandbox}`
const SCRIPTS_OFF = policy("'none'", 'sandbox')
const SCRIPTS_ON = policy("'unsafe-inline' data: blob:", 'sandbox allow-scripts')

afterAll(() => {
  modHost.stopAll()
  fs.rmSync(scratch, { recursive: true, force: true })
})

beforeAll(async () => {
  await modHost.start()
  fs.writeFileSync(path.join(scratch, 'report.html'), PAGE)
  fs.writeFileSync(path.join(scratch, 'old.htm'), PAGE)
  fs.writeFileSync(path.join(scratch, 'notes.txt'), PAGE)
  fs.writeFileSync(path.join(scratch, 'page.xhtml'), PAGE)
  fs.writeFileSync(path.join(scratch, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  fs.writeFileSync(path.join(scratch, 'packed.html'), Buffer.from([0, 1, 2, 3, 255]))
  fs.writeFileSync(path.join(scratch, 'huge.html'), Buffer.alloc(HTML_PREVIEW_MAX + 1, 'a'))
  await tasks.insert({ id: TASK, title: 'Preview', repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
})

const raw = async (file: string, extra: Record<string, string>, headers: Record<string, string> = FRAME) =>
  app.request(`/api/tasks/${TASK}/files/raw?${new URLSearchParams({ root: 'cwd', path: file, ...extra }).toString()}`, {
    headers,
  })

const detail = async (res: Response) => ((await res.json()) as { error: { detail: string } }).error.detail

describe('html preview', () => {
  it('serves an html file inline as a sandboxed page with no network and scripts off', async () => {
    for (const file of ['report.html', 'old.htm']) {
      const res = await raw(file, { preview: '1' })
      expect(res.status, await res.clone().text()).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(res.headers.get('content-disposition')).toBe('inline')
      expect(res.headers.get('content-security-policy')).toBe(SCRIPTS_OFF)
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('referrer-policy')).toBe('no-referrer')
      expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN')
      expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin')
      expect(await res.text()).toBe(PAGE)
    }
  })

  it('lets the page run scripts only when the request asks', async () => {
    const res = await raw('report.html', { preview: '1', scripts: '1' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toBe(SCRIPTS_ON)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    const off = await raw('report.html', { preview: '1', scripts: '0' })
    expect(off.headers.get('content-security-policy')).toBe(SCRIPTS_OFF)
    expect((await raw('report.html', { preview: '1', scripts: 'yes' })).status).toBe(400)
  })

  it('gives a page with scripts on in-memory storage ahead of its own scripts', async () => {
    const res = await raw('report.html', { preview: '1', scripts: '1' })
    const body = Buffer.from(await res.arrayBuffer())
    expect(res.headers.get('content-length')).toBe(String(body.byteLength))
    const text = body.toString('utf8')
    expect(text.startsWith('<!doctype html><script>(function')).toBe(true)
    expect(text).toContain('Object.defineProperty(window, name, { value: memory(), configurable: true })')
    expect(text.endsWith(PAGE.slice('<!doctype html>'.length))).toBe(true)
    const off = await raw('report.html', { preview: '1' })
    expect(await off.text()).toBe(PAGE)
  })

  it('refuses a preview opened outside a frame, scripts on or off', async () => {
    for (const headers of [HEADERS, { ...HEADERS, 'sec-fetch-dest': 'document' }]) {
      for (const scripts of ['0', '1']) {
        const res = await raw('report.html', { preview: '1', scripts }, headers)
        expect(res.status).toBe(403)
        expect(await detail(res)).toBe("HTML previews open only inside Seti's file viewer")
      }
    }
  })

  it('refuses a page over the cap with the reason', async () => {
    const res = await raw('huge.html', { preview: '1' })
    expect(res.status).toBe(413)
    expect(await detail(res)).toBe('huge.html is too large to preview; download it instead')
  })

  it('refuses a preview of a file no viewer serves as a page, and leaves plain and download requests unchanged', async () => {
    for (const file of ['notes.txt', 'logo.svg', 'packed.html', 'page.xhtml']) {
      const refused = await raw(file, { preview: '1', scripts: '1' })
      expect(refused.status).toBe(403)
      expect(await detail(refused)).toBe('No viewer serves this file as a page')
    }
    const text = await raw('notes.txt', {})
    expect(text.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    const svg = await raw('logo.svg', {})
    expect(svg.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox")
    const binary = await raw('packed.html', {})
    expect(binary.headers.get('content-type')).toBe('application/octet-stream')
    expect(binary.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''packed.html")
    const plain = await raw('report.html', { scripts: '1' }, HEADERS)
    expect(plain.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(plain.headers.get('x-frame-options')).toBe('DENY')
    expect(plain.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    for (const extra of [{ download: '1' }, { download: '1', preview: '1', scripts: '1' }]) {
      const download = await raw('report.html', extra)
      expect(download.headers.get('content-type')).toBe('application/octet-stream')
      expect(download.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''report.html")
      expect(download.headers.get('content-security-policy')).not.toContain('allow-scripts')
    }
  })

  it("serves the extensions an enabled mod's page viewer claims, and stops when it stops", async () => {
    const dispose = pageExtensions.register({ extension: 'xhtml', viewer: 'probe.page' })
    try {
      const res = await raw('page.xhtml', { preview: '1' })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-security-policy')).toBe(SCRIPTS_OFF)
    } finally {
      dispose()
    }
    expect((await raw('page.xhtml', { preview: '1' })).status).toBe(403)
  })

  it('serves html and htm as pages only while the HTML preview mod runs', async () => {
    await modHost.setEnabled('html-preview', false)
    try {
      for (const file of ['report.html', 'old.htm']) {
        for (const scripts of ['0', '1']) {
          const refused = await raw(file, { preview: '1', scripts })
          expect(refused.status).toBe(403)
          expect(await detail(refused)).toBe('No viewer serves this file as a page')
        }
      }
      const plain = await raw('report.html', {}, HEADERS)
      expect(plain.headers.get('content-type')).toBe('text/plain; charset=utf-8')
      expect(await plain.text()).toBe(PAGE)
    } finally {
      await modHost.setEnabled('html-preview', true)
    }
    const res = await raw('report.html', { preview: '1' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toBe(SCRIPTS_OFF)
  })

  it('still needs the user to be signed in', async () => {
    const res = await raw('report.html', { preview: '1' }, { host: HEADERS.host, 'sec-fetch-dest': 'iframe' })
    expect(res.status).toBe(401)
  })
})
