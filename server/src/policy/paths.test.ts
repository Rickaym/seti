import { describe, expect, it } from 'vitest'
import { insideAny, pathMatches, resolvePath } from './paths.js'

const scope = { anchor: '/work/app', cwd: '/work/app', home: '/home/me' }
const userScope = { ...scope, anchor: '/home/me/.claude' }

describe('path rule anchors', () => {
  it('reads // as the root, ~/ as home, / as the settings source, else the cwd', () => {
    expect(pathMatches('//srv/scratch.txt', '/srv/scratch.txt', 'deny', scope)).toBe(true)
    expect(pathMatches('~/.zshrc', '/home/me/.zshrc', 'deny', scope)).toBe(true)
    expect(pathMatches('/docs/**', '/work/app/docs/a.md', 'allow', scope)).toBe(true)
    expect(pathMatches('/docs/**', '/docs/a.md', 'allow', scope)).toBe(false)
    expect(pathMatches('./.env', '/work/app/.env', 'deny', scope)).toBe(true)
  })

  it('anchors a /path rule from user settings at ~/.claude', () => {
    expect(pathMatches('/secrets/**', '/home/me/.claude/secrets/k', 'deny', userScope)).toBe(true)
    expect(pathMatches('/secrets/**', '/work/app/secrets/k', 'deny', userScope)).toBe(false)
  })

  it('matches a bare file name at any depth under the cwd only', () => {
    expect(pathMatches('.env', '/work/app/.env', 'deny', scope)).toBe(true)
    expect(pathMatches('.env', '/work/app/pkg/.env', 'deny', scope)).toBe(true)
    expect(pathMatches('**/.env', '/work/app/pkg/.env', 'deny', scope)).toBe(true)
    expect(pathMatches('.env', '/work/.env', 'deny', scope)).toBe(false)
    expect(pathMatches('//**/.env', '/elsewhere/.env', 'deny', scope)).toBe(true)
  })
})

describe('path rule depth', () => {
  const top = '/work/app/src/app.ts'
  const nested = '/work/app/vendor/pkg/src/lib.js'

  it.each([
    ['src/**', 'allow', true, false],
    ['src/**', 'deny', true, true],
    ['src/**', 'ask', true, true],
    ['/src/**', 'allow', true, false],
    ['/src/**', 'deny', true, false],
    ['**/src/**', 'allow', true, true],
    ['**/src/**', 'deny', true, true],
  ] as const)('%s as %s: top %s, nested %s', (rule, behavior, atTop, atDepth) => {
    expect(pathMatches(rule, top, behavior, scope)).toBe(atTop)
    expect(pathMatches(rule, nested, behavior, scope)).toBe(atDepth)
  })

  it('lets a deny on a directory cover what is in it, and an allow only what it names', () => {
    expect(pathMatches('//home/me/.ssh', '/home/me/.ssh/id_rsa', 'deny', scope)).toBe(true)
    expect(pathMatches('//home/me/.ssh', '/home/me/.ssh/id_rsa', 'allow', scope)).toBe(false)
    expect(pathMatches('//home/me/.ssh/**', '/home/me/.ssh', 'deny', scope)).toBe(false)
  })

  it('keeps * inside one segment and reads character classes', () => {
    expect(pathMatches('//w/*.ts', '/w/a.ts', 'allow', scope)).toBe(true)
    expect(pathMatches('//w/*.ts', '/w/sub/a.ts', 'allow', scope)).toBe(false)
    expect(pathMatches('//w/[ab].ts', '/w/b.ts', 'allow', scope)).toBe(true)
    expect(pathMatches('//w/[!ab].ts', '/w/b.ts', 'allow', scope)).toBe(false)
    expect(pathMatches('//w/?.ts', '/w/c.ts', 'allow', scope)).toBe(true)
  })

  it('treats a negation as carving nothing out and * as every path', () => {
    expect(pathMatches('!sample.env', '/work/app/sample.env', 'deny', scope)).toBe(false)
    expect(pathMatches('*', '/anything/at/all', 'deny', scope)).toBe(true)
  })

  it('never allows a path longer than the system opens, and lets every deny cover it', () => {
    const long = `/work/app/${'a/'.repeat(3000)}x`
    expect(pathMatches('/**', long, 'allow', scope)).toBe(false)
    expect(pathMatches('nothing-like-it', long, 'deny', scope)).toBe(true)
  })

  it('reads repeated ** as one', () => {
    expect(pathMatches('/**/**/x', '/work/app/a/b/x', 'allow', scope)).toBe(true)
    expect(pathMatches('/**/**/x', '/work/app/x', 'allow', scope)).toBe(true)
  })
})

describe('resolving paths', () => {
  it('reads ~ as home and relative paths from the cwd', () => {
    expect(resolvePath('~/x', '/w', '/home/me')).toBe('/home/me/x')
    expect(resolvePath('a/../b', '/w', '/home/me')).toBe('/w/b')
    expect(resolvePath('/abs', '/w', '/home/me')).toBe('/abs')
  })

  it('tells inside from beside', () => {
    expect(insideAny('/w/app/x', ['/w/app'])).toBe(true)
    expect(insideAny('/w/app', ['/w/app'])).toBe(true)
    expect(insideAny('/w/apple', ['/w/app'])).toBe(false)
    expect(insideAny('/x', ['/'])).toBe(true)
  })
})
