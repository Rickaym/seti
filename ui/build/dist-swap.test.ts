import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUILDS_FILE, keptBuilds, readBuilds, swapIn, tagBuild } from './dist-swap'

let root = ''
const at = (...parts: string[]) => path.join(root, ...parts)

function stage(files: Record<string, string>): string {
  const staged = at('next')
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(staged, file)), { recursive: true })
    fs.writeFileSync(path.join(staged, file), body)
  }
  return staged
}

const deploy = (id: string, files: Record<string, string>) => {
  swapIn({ staged: stage(files), live: at('dist'), retired: at('retired'), id })
}

const served = () => fs.readdirSync(at('dist', 'assets')).toSorted((a, b) => a.localeCompare(b))

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-dist-swap-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('keptBuilds', () => {
  it('keeps the new build and the two newest older ones, each once', () => {
    const record = (id: string) => ({ id, assets: [`assets/${id}.js`] })
    expect(keptBuilds(record('d'), [record('c'), record('d'), record('b'), record('a')]).map((r) => r.id)).toEqual([
      'd',
      'c',
      'b',
    ])
  })
})

describe('swapIn', () => {
  it('puts the build in place whole and keeps two older builds of hashed files', () => {
    deploy('a', { 'index.html': 'A', 'assets/a.js': 'a' })
    deploy('b', { 'index.html': 'B', 'assets/b.js': 'b' })
    deploy('c', { 'index.html': 'C', 'assets/c.js': 'c' })
    expect(fs.readFileSync(at('dist', 'index.html'), 'utf8')).toBe('C')
    expect(served()).toEqual(['a.js', 'b.js', 'c.js'])

    deploy('d', { 'index.html': 'D', 'assets/d.js': 'd' })
    expect(served()).toEqual(['b.js', 'c.js', 'd.js'])
    expect(readBuilds(at('dist')).map((record) => record.id)).toEqual(['d', 'c', 'b'])
    expect(fs.existsSync(at('next'))).toBe(false)
    expect(fs.existsSync(at('retired'))).toBe(false)
  })

  it('keeps the files of a folder built before the list existed as one older build', () => {
    fs.mkdirSync(at('dist', 'assets'), { recursive: true })
    fs.writeFileSync(at('dist', 'assets', 'old.js'), 'old')
    deploy('a', { 'index.html': 'A', 'assets/a.js': 'a' })
    expect(served()).toEqual(['a.js', 'old.js'])
    expect(JSON.parse(fs.readFileSync(at('dist', BUILDS_FILE), 'utf8'))).toEqual([
      { id: 'a', assets: ['assets/a.js'] },
      { id: 'unnamed', assets: ['assets/old.js'] },
    ])
  })
})

describe('tagBuild', () => {
  it('names the build right after the charset', () => {
    expect(tagBuild('<head>\n    <meta charset="UTF-8" />\n', 'abc123')).toBe(
      '<head>\n    <meta charset="UTF-8" />\n    <meta name="seti-build" content="abc123" />\n',
    )
  })

  it('refuses a page without the charset tag', () => {
    expect(() => tagBuild('<head></head>', 'abc123')).toThrow(/charset/)
  })
})
