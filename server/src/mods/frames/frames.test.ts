import { modManifest } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { checkViewCall } from './calls.js'
import { frameBody, framePolicy, frameHeaders, inlineScriptHashes, scriptHash } from './policy.js'
import { VIEW_SHIM } from './shim.js'
import { HttpError } from '../../http.js'

const manifest = modManifest.parse({
  id: 'linear',
  name: 'Linear',
  version: '1.0.0',
  seti: '^1.1',
  description: 'Links agents to Linear issues',
  main: 'logic.js',
  activation: ['onCommand'],
  capabilities: [{ name: 'storage' }],
  contributes: {
    commands: [
      {
        id: 'link',
        title: 'Link',
        for: ['view'],
        args: { issue: { type: 'string' }, pin: { type: 'boolean', optional: true } },
      },
      { id: 'sync', title: 'Sync', for: ['palette'] },
    ],
    views: [{ id: 'board', title: 'Board', where: 'section', phone: true, entry: 'views/board.html' }],
  },
})

const refusal = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return e instanceof HttpError ? `${String(e.status)} ${e.message}` : String(e)
  }
  return null
}

describe('the frame policy', () => {
  it('pins scripts by hash with no network, no frames, no forms and an opaque origin', () => {
    const page = scriptHash('go()')
    const policy = framePolicy([page])
    expect(policy).toContain(`script-src '${scriptHash(VIEW_SHIM)}' '${page}';`)
    for (const directive of [
      "default-src 'none'",
      "connect-src 'none'",
      'img-src data: blob:',
      'font-src data:',
      "frame-src 'none'",
      "child-src 'none'",
      "worker-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-ancestors 'self'",
      'sandbox allow-scripts',
      "require-trusted-types-for 'script'",
      'trusted-types default',
    ]) {
      expect(policy).toContain(directive)
    }
    expect(policy).not.toContain("unsafe-inline' data")
    expect(policy).not.toMatch(/script-src[^;]*unsafe/)
  })

  it('drops a stored hash that would widen the policy', () => {
    const policy = framePolicy(["sha256-x' 'unsafe-inline", 'sha256-abc', "'unsafe-eval'"])
    expect(policy).toContain(`script-src '${scriptHash(VIEW_SHIM)}';`)
  })

  it('serves frames only, never a tab', () => {
    expect(refusal(() => frameHeaders(undefined, []))).toBe("403 A mod's views open only inside Seti")
    expect(refusal(() => frameHeaders('document', []))).toBe("403 A mod's views open only inside Seti")
    expect(frameHeaders('iframe', [])).toMatchObject({
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    })
  })

  it('puts the shim first, after the doctype, and adds a doctype when the page has none', () => {
    const shim = `<script>${VIEW_SHIM}</script>`
    expect(frameBody('<!-- a --><!DOCTYPE html><p>x</p><script>go()</script>')).toBe(
      `<!-- a --><!DOCTYPE html>${shim}<p>x</p><script>go()</script>`,
    )
    expect(frameBody('\uFEFF<p>x</p>')).toBe(`<!doctype html>${shim}<p>x</p>`)
    expect(VIEW_SHIM).not.toMatch(/<\/script/i)
  })

  it('hashes each inline script body as the browser reads it', () => {
    expect(inlineScriptHashes('<script>a()</script><p></p><script type="module">\nb()\n</script >')).toEqual([
      scriptHash('a()'),
      scriptHash('\nb()\n'),
    ])
  })
})

describe('a view call', () => {
  const call = (input: object) => () => checkViewCall(manifest, { view: 'board', op: 'settings.get', ...input })

  it('runs only commands the mod offers its views, with the arguments it declares', () => {
    expect(
      checkViewCall(manifest, { view: 'board', op: 'command', command: 'link', args: { issue: 'ISS-1' } }),
    ).toEqual({ modId: 'linear', view: 'board', op: 'command', command: 'link', args: { issue: 'ISS-1' } })
    expect(refusal(call({ op: 'command', command: 'sync' }))).toBe('403 Linear does not offer Sync to its views')
    expect(refusal(call({ op: 'command', command: 'gone' }))).toBe('404 Linear has no command gone')
    expect(refusal(call({ op: 'command', command: 'link', args: { issue: 1 } }))).toMatch(/^400 /)
    expect(refusal(call({ op: 'command', command: 'link', args: { issue: 'x', extra: 1 } }))).toMatch(/^400 /)
  })

  it('refuses a page the mod does not declare, storage without a key and a value over 64 KB', () => {
    expect(refusal(call({ view: 'other' }))).toBe('404 Linear has no view other')
    expect(refusal(call({ op: 'storage.get' }))).toBe('400 storage.get takes a key')
    expect(refusal(call({ op: 'storage.set', key: 'k' }))).toBe('400 A stored value is JSON of at most 64 KB')
    expect(refusal(call({ op: 'storage.set', key: 'k', value: 'x'.repeat(70_000) }))).toBe(
      '400 A stored value is JSON of at most 64 KB',
    )
    expect(checkViewCall(manifest, { view: 'board', op: 'storage.set', key: 'k', value: { a: 1 } })).toMatchObject({
      modId: 'linear',
    })
  })
})
