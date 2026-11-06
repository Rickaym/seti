import { MOD_PACKAGE_LIMITS, modManifest } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { iconData, sanitizeSvg } from './icon.js'
import { mapReader, readPackage } from './validate.js'

const MANIFEST = {
  id: 'linear',
  name: 'Linear',
  version: '1.0.0',
  seti: '^1.10',
  description: 'Links issues',
}

const files = (manifest: Record<string, unknown>, extra: Record<string, string | Buffer> = {}) =>
  new Map(
    Object.entries({ 'seti-mod.json': JSON.stringify({ ...MANIFEST, ...manifest }), ...extra }).map(([name, body]) => [
      name,
      Buffer.isBuffer(body) ? body : Buffer.from(body),
    ]),
  )

const read = async (manifest: Record<string, unknown>, extra: Record<string, string | Buffer> = {}) =>
  readPackage(mapReader(files(manifest, extra)), new Set())

const refusal = async (manifest: Record<string, unknown>, extra: Record<string, string | Buffer> = {}) =>
  read(manifest, extra).then(
    () => expect.fail('the package was accepted'),
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  )

function png(width: number, height: number): Buffer {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
  const size = Buffer.alloc(8)
  size.writeUInt32BE(width, 0)
  size.writeUInt32BE(height, 4)
  return Buffer.concat([head, Buffer.from('IHDR', 'latin1'), size, Buffer.alloc(9)])
}

const svgOf = (url: string) => Buffer.from(url.replace('data:image/svg+xml;base64,', ''), 'base64').toString('utf8')

describe('the listing fields of a manifest', () => {
  it('takes a display name, categories, links and doc files', () => {
    const manifest = modManifest.parse({
      ...MANIFEST,
      displayName: 'Linear issues',
      categories: ['integrations', 'agents'],
      homepage: 'https://example.com',
      repository: 'https://github.com/example/linear',
      readme: 'docs/README.md',
      changelog: 'CHANGES.md',
      icon: 'assets/icon.svg',
    })
    expect(manifest).toMatchObject({ displayName: 'Linear issues', categories: ['integrations', 'agents'] })
  })

  it.each([
    [{ description: 'Two\nlines' }, 'A description is one line'],
    [{ categories: ['games'] }, 'categories'],
    [{ categories: ['themes', 'themes'] }, 'A category is listed twice'],
    [{ categories: ['themes', 'viewers', 'agents', 'other'] }, 'categories'],
    [{ homepage: 'http://example.com' }, 'Use an https:// URL'],
    [{ repository: 'https://user:pw@example.com/x' }, 'Use an https:// URL'],
    [{ readme: '../README.md' }, 'Name a Markdown file'],
    [{ readme: 'README.txt' }, 'Name a Markdown file'],
    [{ icon: 'icon.gif' }, 'Name a lucide icon'],
    [{ icon: '../icon.svg' }, 'Name a lucide icon'],
    [{ displayName: 'x'.repeat(61) }, 'displayName'],
  ])('refuses %j', (extra, message) => {
    const parsed = modManifest.safeParse({ ...MANIFEST, ...extra })
    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed.error?.issues)).toContain(message)
  })
})

describe('icons', () => {
  it('rebuilds an SVG from its shapes alone, without scripts, handlers, links or styles', () => {
    const hostile = `<?xml version="1.0"?><svg viewBox="0 0 24 24" onload="alert(1)">
      <script>alert(1)</script><style>path{fill:url(https://evil.example/x)}</style>
      <a href="javascript:alert(1)"><path d="M0 0h24v24H0z"/></a>
      <foreignObject><div>hi</div></foreignObject>
      <image href="https://evil.example/pixel.png"/>
      <use href="https://evil.example/s.svg#a"/>
      <path d="M1 1h2" fill="url(https://evil.example/g)" stroke="url(#grad)" style="fill:red"/>
      <linearGradient id="grad"><stop offset="0" stop-color="#fff"/></linearGradient>
      <title>Logo &amp; mark</title></svg>`
    const result = sanitizeSvg('icon.svg', hostile)
    expect('svg' in result).toBe(true)
    const svg = 'svg' in result ? result.svg : ''
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">')
    expect(svg).toContain('<path d="M1 1h2" stroke="url(#grad)"></path>')
    expect(svg).toContain('<linearGradient id="grad">')
    expect(svg).toContain('<title>Logo &amp; mark</title>')
    for (const gone of ['script', 'onload', 'style', 'href', 'foreignObject', 'image', 'use', 'evil', 'alert']) {
      expect(svg, gone).not.toContain(gone)
    }
  })

  it.each([
    ['<div>not an svg</div>', 'is not one <svg> image'],
    ['<svg></svg><svg></svg>', 'is not one <svg> image'],
    ['<svg><script>alert(1)</script></svg>', 'draws no shapes Seti keeps'],
  ])('refuses %s', (source, problem) => {
    expect(sanitizeSvg('icon.svg', source)).toEqual({ problem: `icon.svg ${problem}` })
  })

  it('takes a PNG within the icon size and refuses a larger one or another format', () => {
    const small = iconData('icon.png', png(128, 128))
    expect('url' in small && small.url.startsWith('data:image/png;base64,')).toBe(true)
    expect(iconData('icon.png', png(1024, 64))).toEqual({
      problem: 'icon.png is 1024 by 64 pixels; an icon is at most 512 by 512',
    })
    expect(iconData('icon.png', Buffer.from('GIF89a........................'))).toEqual({
      problem: 'icon.png is not a PNG image',
    })
  })

  it('serves a checked SVG icon as a data URL of the rebuilt file', () => {
    const checked = iconData('icon.svg', Buffer.from('<svg onload="x()"><circle r="4"/></svg>'))
    expect('url' in checked && svgOf(checked.url)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"></circle></svg>',
    )
  })
})

describe('icons and docs at Check', () => {
  it('keeps the icon, README and changelog the manifest names', async () => {
    const pkg = await read(
      { icon: 'art/icon.svg', readme: 'docs/intro.md' },
      {
        'art/icon.svg': '<svg><rect width="2" height="2"/></svg>',
        'docs/intro.md': '# Linear',
        'CHANGELOG.md': '# 1.0',
      },
    )
    expect([...pkg.files.keys()].sort((a, b) => a.localeCompare(b))).toEqual([
      'art/icon.svg',
      'CHANGELOG.md',
      'docs/intro.md',
      'seti-mod.json',
    ])
  })

  it('refuses a named icon or README that is missing, unsafe or too large', async () => {
    expect(await refusal({ icon: 'icon.svg' })).toBe('icon.svg is missing from the package')
    expect(await refusal({ readme: 'GUIDE.md' })).toBe('GUIDE.md is missing from the package')
    expect(await refusal({ icon: 'icon.svg' }, { 'icon.svg': '<html><body>hi</body></html>' })).toBe(
      'icon.svg is not one <svg> image',
    )
    expect(await refusal({ icon: 'icon.png' }, { 'icon.png': png(600, 600) })).toMatch(/at most 512 by 512/)
    const big = Buffer.alloc(MOD_PACKAGE_LIMITS.iconBytes + 1)
    expect(await refusal({ icon: 'icon.png' }, { 'icon.png': big })).toBe('icon.png is over 32 KB')
    const long = '#'.repeat(MOD_PACKAGE_LIMITS.docBytes + 1)
    expect(await refusal({}, { 'README.md': long })).toBe('README.md is over 64 KB')
  })

  it('counts the icon and docs toward the package size and hash', async () => {
    const plain = await read({})
    const dressed = await read({ icon: 'icon.png' }, { 'icon.png': png(64, 64), 'README.md': '# Linear' })
    expect(dressed.size).toBeGreaterThan(plain.size)
    expect(dressed.hash).not.toBe(plain.hash)
  })
})
