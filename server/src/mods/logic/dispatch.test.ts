import { MOD_LIMITS, MOD_OP_NAMES } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { dispatchModOp, EventCounters, UNAVAILABLE_OPS, type ModEventRun, type OpTable } from './dispatch.js'
import { currentRequestSource } from '../../access.js'
import { HttpError } from '../../http.js'

const RUN: ModEventRun = {
  modId: 'linear',
  grants: ['storage', 'net.fetch', 'connection', 'tasks.read'],
  scopes: {},
  eventId: 'event-1',
  caller: 'webhook',
}

const KEY = ['lin', 'api', 'test', 'value', '0123456789'].join('_')

function setup(ops: Partial<OpTable> = {}) {
  const denied: string[] = []
  const deps = {
    ops: { ...UNAVAILABLE_OPS, ...ops },
    denied: async (_run: ModEventRun, op: string, message: string) => {
      const source = currentRequestSource()
      denied.push(`${source?.via === 'mod' ? source.modId : 'none'} ${op}: ${message}`)
      return Promise.resolve()
    },
  }
  const counters = new EventCounters()
  const call = async (op: string, args: unknown) => dispatchModOp(deps, { run: RUN, counters }, op, args)
  return { counters, denied, call }
}

describe('dispatchModOp', () => {
  it('runs an op as the mod, with the source Seti built and never one from the child', async () => {
    const { call } = setup({
      'storage.get': async (args) => {
        const source = currentRequestSource()
        return Promise.resolve({ key: args.key, source })
      },
    })
    expect(await call('storage.get', { key: 'team' })).toEqual({
      ok: true,
      value: {
        key: 'team',
        source: { via: 'mod', modId: 'linear', grants: RUN.grants, scopes: {}, eventId: 'event-1', caller: 'webhook' },
      },
    })
  })

  it('refuses an op outside the table, including inherited names, and audits it as denied', async () => {
    const { call, denied, counters } = setup()
    expect(await call('constructor', {})).toEqual({
      ok: false,
      error: { code: 'denied', message: 'Mods cannot call constructor' },
    })
    expect(await call('tasks.archive', {})).toMatchObject({ ok: false, error: { code: 'denied' } })
    expect(denied).toEqual([
      'linear constructor: Mods cannot call constructor',
      'linear tasks.archive: Mods cannot call tasks.archive',
    ])
    expect(counters.refused).toHaveLength(2)
  })

  it('refuses an op whose capability was not granted', async () => {
    const { call } = setup()
    expect(await call('files.read', { agentId: 'a', path: 'notes.md' })).toEqual({
      ok: false,
      error: { code: 'denied', message: 'linear was not granted files.read' },
    })
  })

  it('refuses arguments that name another mod, smuggle a prototype or have the wrong shape', async () => {
    const { call, denied } = setup({ 'storage.get': async () => Promise.resolve('ran') })
    for (const args of [
      { key: 'k', modId: 'other' },
      JSON.parse('{"key":"k","__proto__":{"admin":true}}') as unknown,
      { key: '' },
      { key: 'k'.repeat(201) },
      'k',
      null,
    ]) {
      expect(await call('storage.get', args)).toMatchObject({ ok: false, error: { code: 'invalid' } })
    }
    expect(await call('storage.set', { key: 'k' })).toMatchObject({ ok: false, error: { code: 'invalid' } })
    expect(denied).toEqual([])
  })

  it('counts calls and fetches per event', async () => {
    const { call } = setup({
      'settings.get': async () => Promise.resolve({}),
      'net.fetch': async () => Promise.resolve({ status: 200, url: 'https://a.test/', headers: [], body: '' }),
    })
    const fetches = []
    for (let i = 0; i <= MOD_LIMITS.fetchesPerEvent; i++) {
      fetches.push(await call('net.fetch', { url: 'https://a.test/' }))
    }
    expect(fetches.at(-2)).toMatchObject({ ok: true })
    expect(fetches.at(-1)).toEqual({
      ok: false,
      error: { code: 'limit', message: 'An event makes at most 10 requests' },
    })
    let last = await call('settings.get', {})
    for (let i = fetches.length + 2; i <= MOD_LIMITS.callsPerEvent; i++) {
      last = await call('settings.get', {})
    }
    expect(last).toMatchObject({ ok: true })
    expect(await call('settings.get', {})).toEqual({
      ok: false,
      error: { code: 'limit', message: 'An event makes at most 50 calls into Seti' },
    })
  })

  it('maps what an op throws to a code, and takes secrets out of the text', async () => {
    const thrown = (error: Error) => async () => Promise.reject(error)
    const cases: [Error, string][] = [
      [new HttpError(403, 'Linear may not read @reviewer'), 'denied'],
      [new HttpError(404, 'No such agent'), 'failed'],
      [new HttpError(400, 'A key is 1 to 200 characters'), 'invalid'],
      [new HttpError(429, 'Three posts an event'), 'limit'],
      [new HttpError(409, 'The store is busy'), 'busy'],
      [new Error('upstream said Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'failed'],
    ]
    for (const [error, code] of cases) {
      const { call } = setup({ 'tasks.get': thrown(error) })
      const reply = await call('tasks.get', { id: 'task-1' })
      expect(reply).toMatchObject({ ok: false, error: { code } })
      expect(JSON.stringify(reply)).not.toContain('ghp_abcdef')
    }
    const { call } = setup({
      'connection.fetch': async (_args, op) => {
        op.secret(KEY)
        return Promise.reject(new Error(`401 for key ${KEY}`))
      },
    })
    const reply = await call('connection.fetch', { url: 'https://api.linear.app/', connection: 'LINEAR_API_KEY' })
    expect(reply).toEqual({ ok: false, error: { code: 'failed', message: '401 for key [secret]' } })
  })

  it('takes a marked secret out of an answer, and refuses an answer over 1 MB', async () => {
    const { call } = setup({
      'connection.fetch': async (_args, op) => {
        op.secret(KEY)
        return Promise.resolve({ status: 200, url: 'https://api.linear.app/', headers: [['x-echo', KEY]], body: KEY })
      },
      'storage.get': async () => Promise.resolve('x'.repeat(MOD_LIMITS.callResultBytes)),
    })
    const reply = await call('connection.fetch', { url: 'https://api.linear.app/', connection: 'LINEAR_API_KEY' })
    expect(JSON.stringify(reply)).not.toContain(KEY)
    expect(reply).toMatchObject({ ok: true, value: { body: '[secret]' } })
    expect(await call('storage.get', { key: 'big' })).toEqual({
      ok: false,
      error: { code: 'limit', message: 'The answer to storage.get is over 1 MB' },
    })
  })

  it('answers every op with denied until the op table is filled', async () => {
    const run: ModEventRun = { ...RUN, grants: [...RUN.grants, 'tasks.manage', 'chat.post', 'files.read', 'notify'] }
    const deps = { ops: UNAVAILABLE_OPS, denied: async () => Promise.resolve() }
    for (const op of MOD_OP_NAMES) {
      const reply = await dispatchModOp(deps, { run, counters: new EventCounters() }, op, {})
      expect(reply.ok).toBe(false)
    }
  })
})
