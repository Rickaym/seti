import net from 'node:net'
import { describe, expect, it } from 'vitest'
import { cardSvg, nameLines, renderCard } from './card.js'
import { makePdf, makePng } from './fixtures.js'
import { rasterSize } from './image.js'
import { parsePdfInfo } from './pdf.js'
import { fillImages, type PreviewInput } from './preview.js'
import { renderPreview } from './render.js'
import { renderBox, svgSize } from './svg.js'

const SLOW = 180_000

const input = (name: string, content: Buffer, kind: PreviewInput['kind'], mime = 'application/octet-stream') => ({
  name,
  kind,
  mime,
  content,
  images: new Map(),
})

const TOKEN = 'T'.repeat(43)

describe('PDF previews', () => {
  it(
    'renders pages as WebP images, extracts the text and reads the title',
    async () => {
      const preview = await renderPreview(input('report.pdf', makePdf(3, { title: 'Q3 <report>' }), 'pdf'))
      expect(preview.error).toBeNull()
      expect(preview.label).toBe('PDF, 3 pages')
      expect(preview.note).toBeNull()
      expect(preview.images).toHaveLength(3)
      for (const image of preview.images) {
        expect(image.mime).toBe('image/webp')
        expect(rasterSize(image.bytes)?.width).toBe(1200)
      }
      const body = fillImages(preview.body, preview.imageKey, TOKEN)
      expect(body).toContain(`src="${TOKEN}/p/1"`)
      expect(body).toContain(`src="${TOKEN}/p/3"`)
      expect(body).toContain('loading="lazy"')
      expect(body).not.toContain('<summary>Text</summary>')
      expect(body).toMatch(/<div class="tl"><span style="left:11\.765%;top:6\.\d+%;[^"]+">Page 1 heading<\/span><br>/)
      expect(body).toContain('>Line 3 of page 2</span>')
      expect(body.match(/<div class="tl">/g)).toHaveLength(3)
      expect(body).toContain('Q3 &lt;report&gt;')
      expect(preview.thumb).toBe(preview.images[0])
    },
    SLOW,
  )

  it(
    'lays the text of a turned page over its image, turned with it',
    async () => {
      const preview = await renderPreview(input('scan.pdf', makePdf(1, { lines: 1, rotate: 90 }), 'pdf'))
      expect(preview.images[0]?.width).toBeGreaterThan(preview.images[0]?.height ?? Infinity)
      expect(preview.body).toMatch(/transform:rotate\(90deg\) scaleX\([\d.]+\)">Page 1 heading</)
      expect(preview.body).toContain('>Line 0 of page 1</span>')
    },
    SLOW,
  )

  it(
    'renders a PDF with JavaScript and a launch action as images and text only',
    async () => {
      const hostile = makePdf(1, {
        catalog: '/OpenAction 5 0 R /AA << /WC << /S /JavaScript /JS (app.alert\\(2\\)) >> >>',
        objects: [
          '<< /S /Launch /F (/bin/sh) /Next << /S /JavaScript /JS (app.launchURL\\("https://example.com"\\)) >> >>',
        ],
      })
      const preview = await renderPreview(input('evil.pdf', hostile, 'pdf'))
      expect(preview.error).toBeNull()
      expect(preview.images).toHaveLength(1)
      expect(preview.body).not.toMatch(/<script|javascript:|app\.alert|launchURL|<iframe|<object|<embed/i)
    },
    SLOW,
  )

  it(
    'shows the first 50 pages of a 20,000 page PDF and says so',
    async () => {
      const huge = makePdf(20_000, { lines: 0 })
      const preview = await renderPreview(input('huge.pdf', huge, 'pdf'))
      expect(preview.label).toBe('PDF, 20,000 pages')
      expect(preview.note).toBe('first 50 of 20,000 pages shown')
      expect(preview.images).toHaveLength(50)
      expect(preview.body).toContain('First 50 of 20,000 pages shown')
    },
    SLOW,
  )

  it('fails closed on a malformed PDF: no images, a clear message, the download', async () => {
    const preview = await renderPreview(input('broken.pdf', Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog'), 'pdf'))
    expect(preview.images).toEqual([])
    expect(preview.imageKey).toBeNull()
    expect(preview.error).toMatch(/^This PDF could not be previewed: /)
    expect(preview.body).toContain('Download it to open it')
  })

  it('reads the page count and title from pdfinfo', () => {
    expect(parsePdfInfo('Title:          My doc\nPages:           12\n')).toEqual({ pages: 12, title: 'My doc' })
    expect(parsePdfInfo('Syntax Error\n')).toBeNull()
  })
})

describe('SVG previews', () => {
  it('rasterizes a drawing at twice its size and keeps its source to read', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="red"/></svg>'
    const preview = await renderPreview(input('logo.svg', Buffer.from(svg), 'image', 'text/plain; charset=utf-8'))
    expect(preview.error).toBeNull()
    expect(preview.label).toBe('SVG drawing, 120 \u00d7 80')
    expect(preview.images).toHaveLength(1)
    expect(preview.images[0]?.mime).toBe('image/png')
    expect(rasterSize(preview.images[0]?.bytes ?? Buffer.alloc(0))).toEqual({ width: 240, height: 160 })
    expect(preview.body).toContain('width="120" height="80"')
    expect(preview.body).toContain('<summary>View source</summary>')
    expect(preview.body).toContain('&lt;rect')
    expect(preview.body).not.toContain('<svg')
  })

  it('ignores scripts and never reaches out for external references', async () => {
    let connections = 0
    const server = net.createServer((socket) => {
      connections += 1
      socket.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? String(address.port) : '0'
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="50" height="50">',
      '<script>fetch("http://127.0.0.1:PORT/script")</script>',
      '<image href="http://127.0.0.1:PORT/image.png" width="50" height="50"/>',
      '<use xlink:href="http://127.0.0.1:PORT/sprite.svg#a"/>',
      '<style>@import url("http://127.0.0.1:PORT/style.css");</style>',
      '<image href="file:///etc/passwd" width="50" height="50"/>',
      '<rect width="50" height="50" fill="blue" onload="alert(1)"/></svg>',
    ]
      .join('')
      .replaceAll('PORT', port)
    const preview = await renderPreview(input('evil.svg', Buffer.from(svg), 'image', 'text/plain; charset=utf-8'))
    server.close()
    expect(connections).toBe(0)
    expect(preview.images).toHaveLength(1)
    expect(preview.body).not.toMatch(/<script|<svg|<style|onload="/i)
    expect(preview.body).toContain('&lt;script&gt;')
  })

  it('caps the pixels of a drawing that asks for a giant size', () => {
    expect(renderBox(svgSize('<svg width="100000" height="50">'))).toEqual({ width: 2400, height: 1 })
    expect(renderBox(svgSize('<svg viewBox="0 0 30 60">'))).toEqual({ width: 60, height: 120 })
    expect(renderBox(svgSize('<svg>'))).toEqual({ width: 1200, height: 1200 })
  })

  it('falls back to the source when the drawing does not parse', async () => {
    const preview = await renderPreview(input('bad.svg', Buffer.from('<svg <<<'), 'image', 'text/plain; charset=utf-8'))
    expect(preview.images).toEqual([])
    expect(preview.error).toMatch(/^This SVG could not be previewed/)
    expect(preview.body).toContain('&lt;svg &lt;&lt;&lt;')
  })
})

describe('image previews', () => {
  it('shows a PNG from the share image path with its size', async () => {
    const preview = await renderPreview(input('a.png', makePng(64, 32), 'image', 'image/png'))
    expect(preview.label).toBe('PNG image, 64 \u00d7 32')
    expect(preview.images).toHaveLength(1)
    expect(preview.body).toContain('width="64" height="32"')
    expect(preview.body).not.toContain('data:')
  })

  it('converts a BMP to WebP in the sandbox', async () => {
    const bmp = Buffer.alloc(54 + 4 * 4 * 3)
    bmp.write('BM', 0, 'latin1')
    bmp.writeUInt32LE(bmp.length, 2)
    bmp.writeUInt32LE(54, 10)
    bmp.writeUInt32LE(40, 14)
    bmp.writeInt32LE(4, 18)
    bmp.writeInt32LE(4, 22)
    bmp.writeUInt16LE(1, 26)
    bmp.writeUInt16LE(24, 28)
    const preview = await renderPreview(input('a.bmp', bmp, 'image'))
    expect(preview.error).toBeNull()
    expect(preview.label).toBe('BMP image, 4 \u00d7 4')
    expect(preview.images[0]?.mime).toBe('image/webp')
  })

  it('gives a clear message for an image the converter cannot read', async () => {
    const preview = await renderPreview(input('a.tiff', Buffer.from('II*\0garbage'), 'binary'))
    expect(preview.images).toEqual([])
    expect(preview.error).toMatch(/^This TIFF image could not be previewed/)
    expect(preview.body).toContain('Download it to open it')
  })
})

describe('link cards', () => {
  const HOSTILE = [
    'a</text></svg><script>alert(1)</script>.pdf',
    'R&D "quarterly" report\'s <final>.pdf',
    '</svg><image href="http://127.0.0.1/x"/>',
    `bell\u0007and\u0000nul.txt`,
  ]

  it('escapes every hostile name so the template stays one SVG with no script', () => {
    for (const name of HOSTILE) {
      const svg = cardSvg({ name, detail: 'PDF, 1 page, 2 KB', thumb: null })
      expect(svg.match(/<svg/g)).toHaveLength(1)
      expect(svg.match(/<\/svg>/g)).toHaveLength(1)
      expect(svg).not.toContain('<script')
      expect(svg).not.toMatch(/<image href="http/)
      expect(svg).not.toMatch(/\p{Cc}/u)
    }
    expect(cardSvg({ name: HOSTILE[1] ?? '', detail: 'x', thumb: null })).toContain('R&amp;D &quot;quarterly&quot;')
  })

  it('breaks long names onto three lines at most, ending in an ellipsis', () => {
    const lines = nameLines('a'.repeat(100), 20)
    expect(lines).toHaveLength(3)
    expect(lines.at(-1)?.endsWith('\u2026')).toBe(true)
    expect(nameLines('quarterly-report-2026-final-v2.pdf', 20)).toEqual(['quarterly-report-', '2026-final-v2.pdf'])
  })

  it('renders a 1200 by 630 PNG card, with a thumbnail or a type badge', async () => {
    for (const name of HOSTILE) {
      const card = await renderCard({ name, detail: 'PDF, 1 page, 2 KB', thumb: null })
      expect(typeof card === 'string' ? card : rasterSize(card)).toEqual({ width: 1200, height: 630 })
    }
    const thumb = { mime: 'image/png', bytes: makePng(300, 400), width: 300, height: 400 }
    const card = await renderCard({ name: 'photo.png', detail: 'PNG image, 300 \u00d7 400, 1 KB', thumb })
    expect(typeof card === 'string' ? card : rasterSize(card)).toEqual({ width: 1200, height: 630 })
  })
})
