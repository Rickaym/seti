import {
  MOD_LIMITS,
  MOD_OP_NAMES,
  MOD_OPS,
  modBridgeIn,
  modChildMessage,
  modFrameCallInput,
  modHello,
  modParentMessage,
  modPreviewInput,
  modSourceInput,
  type ModGrantScopes,
} from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { asMod, currentRequestSource } from '../access.js'

const HASH = 'a'.repeat(64)
const NONCE = '6f1c1b0e-4a8e-4c63-9a52-3f6f5d1b2c3d'

describe('the op table contract', () => {
  it('lists every op once with the capability it needs, and nothing that installs, grants or reads values', () => {
    expect(MOD_OP_NAMES).toMatchInlineSnapshot(`
      [
        "settings.get",
        "audit.record",
        "status.set",
        "storage.get",
        "storage.keys",
        "storage.set",
        "storage.delete",
        "notify.send",
        "net.fetch",
        "connection.fetch",
        "tasks.list",
        "tasks.get",
        "tasks.transcript",
        "tasks.prs",
        "tasks.manage.rename",
        "tasks.manage.pin",
        "tasks.manage.set_color",
        "tasks.manage.link_pr",
        "tasks.manage.unlink_pr",
        "tasks.manage.start",
        "tasks.manage.stop",
        "chat.post",
        "chat.post.direct",
        "files.list",
        "files.read",
      ]
    `)
    expect(MOD_OPS['tasks.manage.start']).toBe('tasks.manage')
    expect(MOD_OPS['settings.get']).toBeNull()
  })
})

describe('the runner pipe protocol', () => {
  const call = { type: 'call', eventId: 'e1', callId: 1, op: 'storage.get', args: { key: 'k' } }

  it('takes a plain call, and refuses one that claims a mod, grants or a caller', () => {
    expect(modChildMessage.safeParse(call).success).toBe(true)
    for (const claim of [{ modId: 'other' }, { grants: ['net.fetch'] }, { caller: 'user' }, { scopes: {} }]) {
      expect(modChildMessage.safeParse({ ...call, ...claim }).success).toBe(false)
    }
  })

  it('refuses a done line that is neither ok nor an error with a known code', () => {
    const done = { type: 'done', eventId: 'e1', logs: [], usage: { cpuMs: 1, calls: 0 } }
    expect(modChildMessage.safeParse({ ...done, ok: true, value: 1 }).success).toBe(true)
    expect(modChildMessage.safeParse({ ...done, ok: false, error: { code: 'denied', message: 'x' } }).success).toBe(
      true,
    )
    expect(modChildMessage.safeParse({ ...done, ok: false, error: { code: 'root', message: 'x' } }).success).toBe(false)
  })

  it('sends events with a verified hash and the limits', () => {
    const event = {
      type: 'event',
      eventId: 'e1',
      hash: HASH,
      script: 'export default {}',
      event: { kind: 'command', command: 'link', args: {} },
      ctx: { eventId: 'e1', mod: { id: 'linear', version: '1.0.0' }, caller: 'view' },
      limits: {
        memoryBytes: MOD_LIMITS.memoryBytes,
        cpuSliceMs: MOD_LIMITS.cpuSliceMs,
        cpuTotalMs: MOD_LIMITS.cpuTotalMs,
        wallMs: MOD_LIMITS.wallMs,
        calls: MOD_LIMITS.callsPerEvent,
        callArgsBytes: MOD_LIMITS.callArgsBytes,
        outputBytes: MOD_LIMITS.outputBytes,
        logLines: MOD_LIMITS.logLines,
        logLineChars: MOD_LIMITS.logLineChars,
      },
    }
    expect(modParentMessage.safeParse(event).success).toBe(true)
    expect(modParentMessage.safeParse({ ...event, hash: 'nope' }).success).toBe(false)
  })
})

describe('the view bridge contract', () => {
  it('takes the hello only with a nonce', () => {
    expect(modHello.safeParse({ seti: 'mod-hello', v: 1, nonce: NONCE }).success).toBe(true)
    expect(modHello.safeParse({ seti: 'mod-hello', v: 1 }).success).toBe(false)
    expect(modHello.safeParse({ seti: 'mod-hello', v: 2, nonce: NONCE }).success).toBe(false)
  })

  it.each([
    ['a capability op', { t: 'call', id: 1, op: 'net.fetch', url: 'https://x.test' }],
    ['a core route', { t: 'call', id: 1, op: 'route', path: '/api/tasks' }],
    ['another mod', { t: 'call', id: 1, op: 'storage.get', key: 'k', modId: 'other' }],
    ['a zero id', { t: 'call', id: 0, op: 'settings.get' }],
    ['an http link', { t: 'link', url: 'http://evil.test' }],
    ['a javascript link', { t: 'link', url: 'javascript:alert(1)' }],
    ['an open outside Seti', { t: 'open', to: 'https://evil.test' }],
  ])('refuses %s', (_name, message) => {
    expect(modBridgeIn.safeParse(message).success).toBe(false)
  })

  it('takes the mod own calls and refuses a frame call for a capability op', () => {
    expect(modBridgeIn.safeParse({ t: 'call', id: 1, op: 'command', command: 'link' }).success).toBe(true)
    expect(modBridgeIn.safeParse({ t: 'call', id: 2, op: 'storage.set', key: 'k', value: [1] }).success).toBe(true)
    expect(modFrameCallInput.safeParse({ view: 'board', op: 'tasks.list' }).success).toBe(false)
  })
})

describe('install sources', () => {
  it.each([
    ['an http git URL', { kind: 'git', url: 'http://git.example.com/m.git', ref: 'main' }],
    ['a git URL with a password', { kind: 'git', url: 'https://u:p@git.example.com/m.git', ref: 'main' }],
    ['a ref that reads as a flag', { kind: 'git', url: 'https://git.example.com/m.git', ref: '--upload-pack=x' }],
    ['a ref with ..', { kind: 'git', url: 'https://git.example.com/m.git', ref: 'a..b' }],
    ['a relative folder', { kind: 'folder', path: 'mods/x' }],
  ])('refuses %s', (_name, source) => {
    expect(modSourceInput.safeParse(source).success).toBe(false)
  })

  it('takes a folder and a git ref, and nothing else in the preview body', () => {
    expect(modSourceInput.safeParse({ kind: 'git', url: 'https://git.example.com/m.git', ref: 'v1.2.0' }).success).toBe(
      true,
    )
    expect(modPreviewInput.safeParse({ source: { kind: 'folder', path: '/srv/mods/x' }, enable: true }).success).toBe(
      false,
    )
  })
})

describe('the mod request source', () => {
  it('carries scopes, the event and the caller Seti gives it, with defaults for bundled calls', async () => {
    const scopes: ModGrantScopes = { 'net.fetch': { name: 'net.fetch', hosts: ['api.linear.app'] } }
    const event = await asMod(
      { id: 'linear', grants: ['net.fetch'], scopes, eventId: 'e1', caller: 'schedule' },
      async () => Promise.resolve(currentRequestSource()),
    )
    expect(event).toEqual({
      via: 'mod',
      modId: 'linear',
      grants: ['net.fetch'],
      scopes,
      eventId: 'e1',
      caller: 'schedule',
    })
    const bundled = await asMod({ id: 'weather', grants: [] }, async () => Promise.resolve(currentRequestSource()))
    expect(bundled).toMatchObject({ scopes: {}, eventId: null, caller: null })
  })
})
