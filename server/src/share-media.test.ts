import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import type { ShareLink } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { SETI_HOME, UI_DIST, type PublicAccess } from './config.js'
import { converterPath } from './converter.js'
import { sql, tasks } from './db.js'
import { MEDIA_MARK, applyShareHeaders } from './share-path.js'
import { makeDocx } from './share-preview/office-fixtures.js'
import { USER_AUTH } from './test-auth.js'

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  UI_DIST: path.join(process.env.SETI_HOME ?? '', 'ui-dist'),
}))

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

const ACCESS: PublicAccess = {
  hostname: 'seti.example.com',
  origin: 'https://seti.example.com',
  cloudflare: { team: 'myteam.cloudflareaccess.com', aud: 'b'.repeat(64), allowed: null },
}
const SLOW = 180_000

/** Test media is made on the host, by the same ffmpeg the previews run in the sandbox. */
const ffmpegBin = () => converterPath('ffmpeg') ?? '/usr/bin/ffmpeg'
const scratch = fs.mkdtempSync(path.join(path.dirname(SETI_HOME), 'share-media-'))
const TASK = 'media-share-task'
const app = createApp({ access: ACCESS, verify: async () => Promise.resolve('me@example.com') })
const LOOPBACK = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006', ...USER_AUTH }
const links = new Map<string, ShareLink>()
const bytes = new Map<string, Buffer>()

const publicGet = async (url: string, headers: Record<string, string> = {}, method = 'GET') =>
  app.request(url, { method, headers: { host: ACCESS.hostname, 'cf-connecting-ip': '198.51.100.9', ...headers } })

const linkOf = (name: string): ShareLink => {
  const link = links.get(name)
  if (link === undefined) {
    throw new Error(`no share of ${name}`)
  }
  return link
}
const tokenOf = (name: string) => linkOf(name).url.slice(linkOf(name).url.lastIndexOf('/') + 1)
const rawOf = (name: string) => `/share/${tokenOf(name)}/raw`

async function share(file: string): Promise<void> {
  const res = await app.request(`/api/tasks/${TASK}/shares`, {
    method: 'POST',
    headers: { ...LOOPBACK, 'content-type': 'application/json' },
    body: JSON.stringify({ root: 'cwd', path: file }),
  })
  expect(res.status, await res.clone().text()).toBe(200)
  links.set(file, ((await res.json()) as { data: ShareLink }).data)
}

const counts = async (name: string) =>
  (
    await sql<{ view_count: number; unfurl_count: number }[]>`SELECT view_count, unfurl_count FROM share
      WHERE id = ${linkOf(name).share.id}`
  ).at(0)

beforeAll(async () => {
  fs.mkdirSync(UI_DIST, { recursive: true })
  fs.writeFileSync(path.join(UI_DIST, 'index.html'), '<!doctype html><title>Seti shell</title>')
  const cwd = path.join(scratch, 'agent')
  fs.mkdirSync(cwd, { recursive: true })
  const ffmpeg = (name: string, args: readonly string[]) => {
    execFileSync(ffmpegBin(), ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args, path.join(cwd, name)])
  }
  ffmpeg('clip.mp4', [
    ...['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15:duration=1', '-f', 'lavfi', '-i', 'sine=duration=1'],
    ...['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'],
  ])
  ffmpeg('tone.mp3', ['-f', 'lavfi', '-i', 'sine=duration=1', '-c:a', 'libmp3lame'])
  fs.writeFileSync(path.join(cwd, 'memo.docx'), makeDocx(['Board memo', 'Ship the media previews.']))
  fs.writeFileSync(path.join(cwd, 'plain.txt'), 'hello\n')
  for (const name of ['clip.mp4', 'tone.mp3', 'memo.docx', 'plain.txt']) {
    bytes.set(name, fs.readFileSync(path.join(cwd, name)))
  }
  await tasks.insert({ id: TASK, title: 'Media publisher', repo_id: null, cwd, worktree: false, pr_urls: [] })
  const sharing = await app.request('/api/shares/settings', {
    method: 'PUT',
    headers: { ...LOOPBACK, 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  })
  expect(sharing.status).toBe(200)
  for (const file of bytes.keys()) {
    await share(file)
  }
}, SLOW)

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

const file = (name: string) => bytes.get(name) ?? Buffer.alloc(0)

describe('media share pages', () => {
  it('play a video under a policy that allows its own download and poster, nothing else', async () => {
    const token = tokenOf('clip.mp4')
    const res = await publicGet(`/share/${token}`)
    expect(res.status).toBe(200)
    const own = `${ACCESS.origin}/share/${token}`
    expect(res.headers.get('content-security-policy')).toBe(
      `sandbox allow-downloads; default-src 'none'; img-src ${own}/p/; media-src ${own}/raw; ` +
        "style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    )
    expect(res.headers.get('x-seti-share-media')).toBeNull()
    const html = await res.text()
    expect(html).toContain(`poster="${token}/p/1"`)
    expect(html).toContain(`src="${token}/raw"`)
    expect(html).not.toMatch(/<script|autoplay/i)
    expect(linkOf('clip.mp4').share.preview).toMatchObject({ label: 'Video, 0:01, 320 \u00d7 180', images: 1 })
    const poster = await publicGet(`/share/${token}/p/1`)
    expect(poster.headers.get('content-type')).toBe('image/webp')
    const card = await publicGet(`/share/${token}/card.png`)
    expect(card.status).toBe(200)
    const slack = await (await publicGet(`/share/${token}`, { 'user-agent': 'Slackbot-LinkExpanding 1.0' })).text()
    expect(slack).toContain('<meta property="og:type" content="website">')
    expect(slack).toMatch(/<meta property="og:description" content="Video, 0:01, 320 \u00d7 180, [\d.]+ KB">/)
  })

  it('keep the policy of a text and an Office share free of media', async () => {
    for (const name of ['plain.txt', 'memo.docx']) {
      const res = await publicGet(`/share/${tokenOf(name)}`)
      expect(res.headers.get('content-security-policy'), name).not.toContain('media-src')
      expect((await publicGet(rawOf(name))).headers.get('cross-origin-resource-policy'), name).toBe('same-origin')
    }
    const memo = await (await publicGet(`/share/${tokenOf('memo.docx')}`)).text()
    expect(memo).toContain('Ship the media previews.')
    expect(memo).toContain(`src="${tokenOf('memo.docx')}/p/1"`)
    expect(linkOf('memo.docx').share.preview).toMatchObject({ label: 'Word document, 1 page', error: null })
  })

  it('serve audio and video downloads typed for their player, readable by the sandboxed page', async () => {
    for (const [name, type] of [
      ['clip.mp4', 'video/mp4'],
      ['tone.mp3', 'audio/mpeg'],
    ] as const) {
      const res = await publicGet(rawOf(name))
      expect(res.headers.get('content-type'), name).toBe(type)
      expect(res.headers.get('cross-origin-resource-policy'), name).toBe('cross-origin')
      expect(res.headers.get('content-security-policy'), name).toContain("img-src 'none'")
      expect(res.headers.get('content-security-policy'), name).not.toContain('media-src')
      expect(res.headers.get('accept-ranges'), name).toBe('bytes')
      expect(Buffer.from(await res.arrayBuffer())).toEqual(file(name))
    }
  })
})

describe('byte ranges of a download', () => {
  it('answer one range with 206 and only those bytes', async () => {
    const whole = file('clip.mp4')
    const size = whole.length
    for (const [header, start, end] of [
      ['bytes=0-99', 0, 99],
      ['bytes=100-', 100, size - 1],
      ['bytes=-50', size - 50, size - 1],
      ['bytes=10-999999999', 10, size - 1],
      ['bytes=0-', 0, size - 1],
    ] as const) {
      const res = await publicGet(rawOf('clip.mp4'), { range: header })
      expect(res.status, header).toBe(206)
      expect(res.headers.get('content-range'), header).toBe(`bytes ${String(start)}-${String(end)}/${String(size)}`)
      expect(res.headers.get('content-length'), header).toBe(String(end - start + 1))
      expect(res.headers.get('content-type'), header).toBe('video/mp4')
      expect(Buffer.from(await res.arrayBuffer()), header).toEqual(whole.subarray(start, end + 1))
    }
  })

  it('answer a range past the end with 416 and the size', async () => {
    const size = file('tone.mp3').length
    for (const header of [`bytes=${String(size)}-`, 'bytes=-0', `bytes=${'9'.repeat(30)}-`]) {
      const res = await publicGet(rawOf('tone.mp3'), { range: header })
      expect(res.status, header).toBe(416)
      expect(res.headers.get('content-range'), header).toBe(`bytes */${String(size)}`)
      expect((await res.arrayBuffer()).byteLength, header).toBe(0)
    }
  })

  it('send the whole file for several ranges, a malformed header or an If-Range', async () => {
    for (const headers of [
      { range: 'bytes=0-1,4-5' },
      { range: 'bytes=5-1' },
      { range: 'bytes=x-' },
      { range: 'pages=1-2' },
      { range: 'bytes=0-1', 'if-range': '"abc"' },
    ]) {
      const res = await publicGet(rawOf('plain.txt'), headers)
      expect(res.status, JSON.stringify(headers)).toBe(200)
      expect(res.headers.get('content-range')).toBeNull()
      expect(await res.text()).toBe('hello\n')
    }
  })

  it('answer a HEAD with the range and its length, and no bytes', async () => {
    const size = file('clip.mp4').length
    const head = await publicGet(rawOf('clip.mp4'), { range: 'bytes=0-9' }, 'HEAD')
    expect(head.status).toBe(206)
    expect(head.headers.get('content-range')).toBe(`bytes 0-9/${String(size)}`)
    expect(head.headers.get('content-length')).toBe('10')
    expect((await head.arrayBuffer()).byteLength).toBe(0)
    const plain = await publicGet(rawOf('clip.mp4'), {}, 'HEAD')
    expect(plain.status).toBe(200)
    expect(plain.headers.get('content-length')).toBe(String(size))
  })

  it('count a page view and a plain download, never a player fetching ranges', async () => {
    const before = await counts('clip.mp4')
    await publicGet(`/share/${tokenOf('clip.mp4')}`)
    for (const range of ['bytes=0-', 'bytes=0-1', 'bytes=1000-', 'bytes=-10']) {
      await publicGet(rawOf('clip.mp4'), { range, 'sec-fetch-dest': 'video' })
    }
    await publicGet(rawOf('clip.mp4'), { range: 'bytes=0-1' })
    await publicGet(rawOf('clip.mp4'), { 'sec-fetch-dest': 'video' })
    await publicGet(rawOf('clip.mp4'), { range: `bytes=${'9'.repeat(20)}-` })
    await publicGet(rawOf('clip.mp4'), {}, 'HEAD')
    expect((await counts('clip.mp4'))?.view_count).toBe((before?.view_count ?? 0) + 1)
    await publicGet(rawOf('clip.mp4'))
    expect((await counts('clip.mp4'))?.view_count).toBe((before?.view_count ?? 0) + 2)
    expect((await counts('clip.mp4'))?.unfurl_count).toBe(before?.unfurl_count ?? 0)
  })

  it('keep every other path of a media share private', async () => {
    const token = tokenOf('clip.mp4')
    for (const url of [`/share/${token}/raw/0-9`, `/share/${token}/raw.mp4`, `/share/${token}/media`]) {
      expect((await publicGet(url)).status, url).toBe(403)
    }
    expect((await publicGet(`/share/${token}/p/2`)).status).toBe(404)
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      expect((await publicGet(rawOf('clip.mp4'), { range: 'bytes=0-1' }, method)).status, method).toBe(403)
    }
  })
})

describe('the share policy per kind', () => {
  const token = 'A'.repeat(43)
  const origin = 'https://seti.example.com'
  const headersFor = (url: string, media: boolean) => {
    const headers = new Headers(media ? { [MEDIA_MARK]: '1' } : {})
    applyShareHeaders(headers, url, origin)
    return headers
  }
  const own = `${origin}/share/${token}`

  it('lets only a media page play only its own download', () => {
    const page = headersFor(`/share/${token}`, true)
    const policy = page.get('content-security-policy') ?? ''
    expect(policy).toContain(`img-src ${own}/p/; media-src ${own}/raw;`)
    expect(policy).toContain("sandbox allow-downloads; default-src 'none'")
    expect(policy).not.toMatch(/script-src|connect-src|'self'|\*/)
    expect(page.has(MEDIA_MARK)).toBe(false)
    expect(page.get('cross-origin-resource-policy')).toBe('same-origin')
  })

  it('keeps every other page and part as strict as before', () => {
    expect(headersFor(`/share/${token}`, false).get('content-security-policy')).not.toContain('media-src')
    for (const part of ['raw', 'p/1', 'card.png']) {
      const headers = headersFor(`/share/${token}/${part}`, true)
      expect(headers.get('content-security-policy'), part).toContain("img-src 'none';")
      expect(headers.get('content-security-policy'), part).not.toContain('media-src')
      expect(headers.has(MEDIA_MARK), part).toBe(false)
    }
    expect(headersFor(`/share/${token}/x`, true).get('content-security-policy')).not.toContain('media-src')
  })

  it('lets the player of a media page read its download cross-origin, and no other download', () => {
    expect(headersFor(`/share/${token}/raw`, true).get('cross-origin-resource-policy')).toBe('cross-origin')
    expect(headersFor(`/share/${token}/raw`, false).get('cross-origin-resource-policy')).toBe('same-origin')
    expect(headersFor(`/share/${token}/raw/x`, true).get('cross-origin-resource-policy')).toBe('same-origin')
  })
})
