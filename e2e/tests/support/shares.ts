import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { APIRequestContext, Browser, Page, Response } from '@playwright/test'
import type { Envelope, ShareLink } from '@seti/shared'
import { openSeedDb } from './db.js'
import { paths } from './env.js'
import { expect } from './fixtures.js'
import { makeCsv, makeNotebook, makePdf, SVG } from './share-files.js'

const MEDIA = path.join(import.meta.dirname, 'media')

/** A 32 px PNG, so a loaded image has a width to check. */
const PNG = fs.readFileSync(path.join(MEDIA, 'dot.png'))

/** A page's policy: no script, no origin, images only from its own path, media only its download. */
function shareCsp(url: string, media: boolean): string {
  const play = media ? `media-src ${url}/raw; ` : ''
  return (
    `sandbox allow-downloads; default-src 'none'; img-src ${url}/p/; ${play}` +
    "style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
  )
}

/** ffmpeg as the apt package installs it, the same one the server's previews run. */
const FFMPEG = '/usr/bin/ffmpeg'

const GH_TOKEN = `ghp_${'e2eT0ken'.repeat(5)}`

/** An idle agent whose docs folder holds a note with an image, an HTML page and a leaky file. */
export async function seedShareAgent(): Promise<{ id: string; dir: string; title: string }> {
  const id = randomUUID()
  const dir = path.join(paths.root, `share-${id.slice(0, 8)}`)
  fs.mkdirSync(path.join(dir, 'docs', 'img'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'docs', 'notes.md'), '# Launch notes\n\n![chart](img/chart.png)\n\nShip it.\n')
  fs.writeFileSync(path.join(dir, 'docs', 'img', 'chart.png'), PNG)
  fs.writeFileSync(path.join(dir, 'docs', 'page.html'), '<h1>Hi</h1><script>document.title = "ran"</script>\n')
  fs.writeFileSync(path.join(dir, 'docs', 'leaky.txt'), `deploy notes\ntoken ${GH_TOKEN}\n`)
  fs.writeFileSync(path.join(dir, 'docs', 'report.pdf'), makePdf(3, 'Quarterly report'))
  fs.writeFileSync(path.join(dir, 'docs', 'numbers.csv'), makeCsv())
  fs.writeFileSync(path.join(dir, 'docs', 'analysis.ipynb'), makeNotebook())
  fs.writeFileSync(path.join(dir, 'docs', 'logo.svg'), SVG)
  fs.copyFileSync(path.join(MEDIA, 'memo.docx'), path.join(dir, 'docs', 'memo.docx'))
  const db = openSeedDb()
  const title = `Share files ${id.slice(0, 8)}`
  await db.idleTask(id, title, dir, new Date(Date.now() - 60_000).toISOString())
  await db.close()
  return { id, dir, title }
}

/** A one second test-pattern MP4 and a one second MP3 tone, beside the agent's other docs. */
export function seedShareMedia(dir: string): void {
  fs.copyFileSync(path.join(MEDIA, 'clip.mp4'), path.join(dir, 'docs', 'clip.mp4'))
  const tone = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libmp3lame', '-b:a', '32k']
  const quiet = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y']
  execFileSync(FFMPEG, [...quiet, ...tone, path.join(dir, 'docs', 'tone.mp3')])
}

export async function setSharing(request: APIRequestContext, enabled: boolean): Promise<void> {
  expect((await request.put('/api/shares/settings', { data: { enabled } })).ok()).toBe(true)
}

/** Shares a file of the agent's docs folder through the API and returns its link. */
export async function shareByApi(request: APIRequestContext, taskId: string, file: string): Promise<string> {
  const res = await request.post(`/api/tasks/${taskId}/shares`, { data: { root: 'cwd', path: `docs/${file}` } })
  expect(res.ok(), await res.text()).toBe(true)
  return ((await res.json()) as Envelope<ShareLink>).data.url
}

export interface Stranger {
  page: Page
  /** What the share's policy refused to load, such as an image or a style. */
  errors: string[]
  close: () => Promise<void>
}

/** A browser with no Seti headers or cookies, like someone the link was sent to. */
export async function stranger(browser: Browser, viewport = { width: 1280, height: 800 }): Promise<Stranger> {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().startsWith('Refused to')) {
      errors.push(message.text())
    }
  })
  return { page, errors, close: async () => context.close() }
}

/** Opens a share link and checks the headers every share page carries. */
export async function openShare(page: Page, url: string, { media = false } = {}): Promise<Response> {
  const res = await page.goto(url)
  if (res === null) {
    throw new Error(`No response for ${url}`)
  }
  const headers = res.headers()
  expect(headers['content-security-policy']).toBe(shareCsp(url, media))
  expect(headers['referrer-policy']).toBe('no-referrer')
  expect(headers['x-robots-tag']).toBe('noindex, nofollow')
  expect(headers['cache-control']).toBe('no-store')
  expect(headers['set-cookie']).toBeUndefined()
  return res
}
