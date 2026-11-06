import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { converterPath } from '../converter.js'
import { cardSvg } from './card.js'
import { rasterSize } from './image.js'
import { codecsOf, durationLabel, parseProbe, playsInBrowsers, type MediaProbe } from './media-probe.js'
import { makeDocx, makeMacroOdt, makeOdf, makeXlsx } from './office-fixtures.js'
import { fillImages, type PreviewInput } from './preview.js'
import { renderPreview } from './render.js'

const SLOW = 180_000

/** Test media is made on the host, by the same ffmpeg the previews run in the sandbox. */
const ffmpegBin = () => converterPath('ffmpeg') ?? '/usr/bin/ffmpeg'
const TOKEN = 'T'.repeat(43)

const input = (name: string, content: Buffer, kind: PreviewInput['kind'], mime = 'application/octet-stream') => ({
  name,
  kind,
  mime,
  content,
  images: new Map(),
})

const served = (body: string, key: string | null) => fillImages(body, key, TOKEN)

async function listener(): Promise<{ port: string; connections: () => number; close: () => void }> {
  let connections = 0
  const server = net.createServer((socket) => {
    connections += 1
    socket.destroy()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? String(address.port) : '0'
  return { port, connections: () => connections, close: () => server.close() }
}

describe('Office previews', () => {
  it(
    'turns a Word document into page images and text through LibreOffice',
    async () => {
      const docx = makeDocx(['Quarterly memo', 'Revenue grew in every region.'])
      const preview = await renderPreview(input('memo.docx', docx, 'binary'))
      expect(preview.error).toBeNull()
      expect(preview.label).toBe('Word document, 1 page')
      expect(preview.images).toHaveLength(1)
      expect(preview.images[0]?.mime).toBe('image/webp')
      expect(rasterSize(preview.images[0]?.bytes ?? Buffer.alloc(0))?.width).toBe(1200)
      const body = served(preview.body, preview.imageKey)
      expect(body).toContain(`src="${TOKEN}/p/1"`)
      expect(body).toContain('alt="Page 1"')
      expect(body).toContain('Revenue grew in every region.')
      expect(body).not.toMatch(/<script|<iframe|<object|<embed/i)
      expect(preview.thumb).toBe(preview.images[0])
    },
    SLOW,
  )

  it(
    'names spreadsheets and slides for what they are',
    async () => {
      const sheet = await renderPreview(input('q3.xlsx', makeXlsx([['Region', 'Revenue']]), 'spreadsheet'))
      expect(sheet.error).toBeNull()
      expect(sheet.label).toBe('Spreadsheet, 1 page')
      expect(sheet.body).toContain('Region')
      const slides = makeOdf(
        'presentation',
        ['One', 'Two']
          .map(
            (title) =>
              `<draw:page draw:name="${title}"><draw:frame svg:x="2cm" svg:y="2cm" svg:width="20cm" svg:height="3cm"><draw:text-box><text:p>Slide ${title}</text:p></draw:text-box></draw:frame></draw:page>`,
          )
          .join(''),
      )
      const deck = await renderPreview(input('deck.odp', slides, 'binary'))
      expect(deck.error).toBeNull()
      expect(deck.label).toBe('Slides, 2 slides')
      expect(deck.body).toContain('alt="Slide 2"')
      expect(deck.body).toContain('Slide Two')
    },
    SLOW,
  )

  it(
    'never runs a document macro that would fire on open',
    async () => {
      const preview = await renderPreview(input('macro.odt', makeMacroOdt('MACRO-RAN-MARKER'), 'binary'))
      expect(preview.error).toBeNull()
      expect(preview.label).toBe('Document, 1 page')
      expect(preview.body).toContain('Macro fixture')
      expect(preview.body).not.toContain('MACRO-RAN-MARKER')
    },
    SLOW,
  )

  it(
    'never fetches a linked image from the network',
    async () => {
      const host = await listener()
      const frame =
        '<draw:frame svg:width="4cm" svg:height="4cm"><draw:image ' +
        `xlink:href="http://127.0.0.1:${host.port}/logo.png" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>`
      const odt = makeOdf('text', `<text:p>Linked picture</text:p><text:p>${frame}</text:p>`)
      const preview = await renderPreview(input('linked.odt', odt, 'binary'))
      host.close()
      expect(host.connections()).toBe(0)
      expect(preview.body).toContain('Linked picture')
    },
    SLOW,
  )

  it(
    'fails closed on a broken document, with a message and the download',
    async () => {
      const preview = await renderPreview(input('broken.docx', Buffer.from('PK\u0003\u0004 not really'), 'binary'))
      expect(preview.images).toEqual([])
      expect(preview.error).toMatch(/^This document could not be previewed: /)
      expect(preview.label).toBe('Word document')
      expect(preview.body).toContain('Download it to open it')
    },
    SLOW,
  )
})

const media = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-media-'))
const FFMPEG = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y']
const SOURCE = ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15:duration=1']
const TONE = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1']

const make = (name: string, args: readonly string[]) => {
  execFileSync(ffmpegBin(), [...FFMPEG, ...args, path.join(media, name)])
  return fs.readFileSync(path.join(media, name))
}

const files = new Map<string, Buffer>()

beforeAll(() => {
  const h264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']
  files.set('clip.mp4', make('clip.mp4', [...SOURCE, ...TONE, ...h264]))
  files.set(
    'turned.mp4',
    make('turned.mp4', ['-display_rotation', '90', '-i', path.join(media, 'clip.mp4'), '-c', 'copy']),
  )
  files.set('clip.mkv', make('clip.mkv', ['-i', path.join(media, 'clip.mp4'), '-c', 'copy']))
  files.set(
    'clip.webm',
    make('clip.webm', [
      ...SOURCE,
      ...TONE,
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      '-c:a',
      'libopus',
      '-shortest',
    ]),
  )
  files.set('tone.mp3', make('tone.mp3', [...TONE, '-c:a', 'libmp3lame']))
})

afterAll(() => {
  fs.rmSync(media, { recursive: true, force: true })
})

const file = (name: string) => files.get(name) ?? Buffer.alloc(0)

describe('audio and video previews', () => {
  it(
    'plays an MP4 natively with its poster, length and size, from the share download',
    async () => {
      const preview = await renderPreview(input('clip.mp4', file('clip.mp4'), 'video', 'video/mp4'))
      expect(preview.error).toBeNull()
      expect(preview.label).toBe('Video, 0:01, 320 \u00d7 180')
      expect(preview.note).toBeNull()
      expect(preview.images).toHaveLength(1)
      expect(preview.images[0]?.mime).toBe('image/webp')
      expect(rasterSize(preview.images[0]?.bytes ?? Buffer.alloc(0))).toEqual({ width: 320, height: 180 })
      const body = served(preview.body, preview.imageKey)
      expect(body).toContain(
        `<video class="media" controls playsinline preload="metadata" poster="${TOKEN}/p/1" width="320" height="180" src="${TOKEN}/raw"`,
      )
      expect(body).not.toMatch(/<script|autoplay|<source|<iframe|<object|<embed/i)
      expect(preview.thumb).toBe(preview.images[0])
    },
    SLOW,
  )

  it(
    'plays WebM and MP3, and shows a poster with a download for a format browsers do not play',
    async () => {
      const webm = await renderPreview(input('clip.webm', file('clip.webm'), 'video', 'video/webm'))
      expect(served(webm.body, webm.imageKey)).toContain(`src="${TOKEN}/raw"`)
      const mp3 = await renderPreview(input('tone.mp3', file('tone.mp3'), 'audio', 'audio/mpeg'))
      expect(mp3.label).toBe('Audio, 0:01')
      expect(mp3.images).toEqual([])
      expect(served(mp3.body, mp3.imageKey)).toContain(
        `<audio class="media" controls preload="metadata" src="${TOKEN}/raw" aria-label="tone.mp3">`,
      )
      const mkv = await renderPreview(input('clip.mkv', file('clip.mkv'), 'video', 'video/x-matroska'))
      expect(mkv.note).toBe('download to play: browsers do not play MKV (H.264, AAC)')
      const body = served(mkv.body, mkv.imageKey)
      expect(body).not.toMatch(/<video|<audio|\/raw/)
      expect(body).toContain(`<img class="poster" src="${TOKEN}/p/1"`)
      expect(body).toContain('Download to play: browsers do not play MKV')
    },
    SLOW,
  )

  it(
    'turns the size of a video recorded on its side',
    async () => {
      const preview = await renderPreview(input('turned.mp4', file('turned.mp4'), 'video', 'video/mp4'))
      expect(preview.label).toBe('Video, 0:01, 180 \u00d7 320')
      expect(rasterSize(preview.images[0]?.bytes ?? Buffer.alloc(0))).toEqual({ width: 180, height: 320 })
    },
    SLOW,
  )

  it(
    'fails closed on bytes that are not media',
    async () => {
      const preview = await renderPreview(input('fake.mp4', Buffer.from('<html><script>alert(1)</script>'), 'video'))
      expect(preview.error).toMatch(/^This video could not be previewed: /)
      expect(preview.body).not.toMatch(/<video|<script/)
      expect(preview.body).toContain('Download it to open it')
    },
    SLOW,
  )

  it('draws a play button over a video poster on the link card', () => {
    const thumb = { mime: 'image/webp', bytes: Buffer.from('x'), width: 320, height: 180 }
    const svg = cardSvg({ name: 'clip.mp4', detail: 'Video, 0:01', thumb, play: true })
    expect(svg).toContain('preserveAspectRatio="xMidYMid meet"')
    expect(svg).toContain('<polygon')
    expect(cardSvg({ name: 'a.pdf', detail: 'PDF', thumb: { ...thumb, width: 100, height: 200 } })).not.toContain(
      '<polygon',
    )
  })
})

const probe = (fields: Partial<MediaProbe>): MediaProbe => ({
  containers: ['mov', 'mp4', 'm4a'],
  duration: 1,
  video: { codec: 'h264', width: 2, height: 2 },
  audio: 'aac',
  cover: false,
  ...fields,
})

describe('media probes', () => {
  it('reads ffprobe JSON and refuses anything else', () => {
    const report = JSON.stringify({
      streams: [
        { codec_type: 'video', codec_name: 'mjpeg', width: 600, height: 600, disposition: { attached_pic: 1 } },
        { codec_type: 'audio', codec_name: 'mp3' },
      ],
      format: { format_name: 'mp3', duration: '205.4' },
    })
    expect(parseProbe(report)).toEqual({ containers: ['mp3'], duration: 205.4, video: null, audio: 'mp3', cover: true })
    for (const bad of ['', 'nope', '[]', '{"streams":[]}', '{"format":{"format_name":5}}']) {
      expect(parseProbe(bad), bad).toBeNull()
    }
    const odd = JSON.stringify({ format: { format_name: 'wav', duration: '1e300' }, streams: [{ width: -1 }] })
    expect(parseProbe(odd)).toBeNull()
    const huge = JSON.stringify({ format: { format_name: 'wav', duration: '1e300' } })
    expect(parseProbe(huge)?.duration).toBeNull()
  })

  it('plays only the containers and codecs every browser decodes', () => {
    expect(playsInBrowsers('mp4', probe({}))).toBe(true)
    expect(playsInBrowsers('mp4', probe({ video: { codec: 'hevc', width: 2, height: 2 } }))).toBe(false)
    expect(playsInBrowsers('mov', probe({}))).toBe(false)
    expect(playsInBrowsers('mkv', probe({ containers: ['matroska', 'webm'] }))).toBe(false)
    const webm = { containers: ['matroska', 'webm'], audio: 'opus' }
    expect(playsInBrowsers('webm', probe({ ...webm, video: { codec: 'vp9', width: 2, height: 2 } }))).toBe(true)
    expect(playsInBrowsers('webm', probe({ ...webm, video: { codec: 'h264', width: 2, height: 2 } }))).toBe(false)
    expect(playsInBrowsers('mp3', probe({ containers: ['mp3'], video: null, audio: 'mp3', cover: true }))).toBe(true)
    expect(playsInBrowsers('mp3', probe({ containers: ['wav'], video: null, audio: 'pcm_s16le' }))).toBe(false)
    expect(playsInBrowsers('wav', probe({ containers: ['wav'], video: null, audio: 'pcm_s16le' }))).toBe(true)
    expect(playsInBrowsers('ogg', probe({ containers: ['ogg'], video: null, audio: 'flac' }))).toBe(false)
    expect(playsInBrowsers('m4a', probe({ video: null, audio: 'alac' }))).toBe(false)
    expect(playsInBrowsers('mp4', probe({ video: null, audio: null }))).toBe(false)
    expect(codecsOf(probe({ video: { codec: 'hevc', width: 2, height: 2 }, audio: 'pcm_s24le' }))).toBe('H.265, PCM')
  })

  it('writes lengths the way players do', () => {
    expect([0, 0.3, 7, 205.4, 3729].map(durationLabel)).toEqual(['0:00', '0:01', '0:07', '3:25', '1:02:09'])
  })
})
