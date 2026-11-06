import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { ModEvent } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { ModLogicJob } from './child.js'
import { dispatchModOp, UNAVAILABLE_OPS, type OpTable } from './dispatch.js'
import { createModLogicPool, type ModLogicPool, type ModLogicPoolOptions } from './pool.js'
import { isolation, type Isolation } from '../../script-sandbox.js'

const HASH = 'a'.repeat(64)
let events = 0

const command = (args: unknown = {}): ModEvent => ({ kind: 'command', command: 'go', args })

/** A logic.js whose `go` command runs the given body with (args, ctx, seti) in scope. */
const logic = (body: string, top = '') =>
  `${top}\nexport default { commands: { go: async (args, ctx, seti) => { ${body} } } }`

function job(script: string, event: ModEvent = command(), wallMs = 10_000): ModLogicJob {
  events += 1
  return {
    run: { modId: 'hostile', grants: ['storage'], scopes: {}, eventId: `event-${String(events)}`, caller: 'user' },
    version: '1.0.0',
    hash: HASH,
    script,
    event,
    wallMs,
  }
}

const calls: { op: string; args: unknown }[] = []
const record: OpTable['storage.get'] = async (args) => {
  calls.push({ op: 'storage.get', args })
  return Promise.resolve(`value of ${args.key}`)
}
const OPS: OpTable = {
  ...UNAVAILABLE_OPS,
  'storage.get': record,
  'storage.set': async (args) => {
    calls.push({ op: 'storage.set', args })
    return Promise.resolve(null)
  },
  'settings.get': async () => Promise.resolve({ team: 'core' }),
}

const pools: ModLogicPool[] = []
function pool(options: Partial<ModLogicPoolOptions> = {}): ModLogicPool {
  const created = createModLogicPool({
    size: 1,
    isolation: 'node',
    dispatch: async (event, op, args) =>
      dispatchModOp({ ops: OPS, denied: async () => Promise.resolve() }, event, op, args),
    ...options,
  })
  pools.push(created)
  return created
}

afterAll(() => {
  for (const created of pools) {
    created.close()
  }
})

/** A stand-in runner that speaks the pipe protocol and then misbehaves as `body` says. */
function patchedRunner(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-mod-runner-'))
  const file = path.join(dir, 'runner.mjs')
  const source = `
import fs from 'node:fs'
const send = (message) => fs.writeSync(1, (typeof message === 'string' ? message : JSON.stringify(message)) + '\\n')
let buffered = ''
const replies = []
let onEvent = null
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffered += chunk
  for (let end = buffered.indexOf('\\n'); end !== -1; end = buffered.indexOf('\\n')) {
    const message = JSON.parse(buffered.slice(0, end))
    buffered = buffered.slice(end + 1)
    if (message.type === 'event') onEvent(message)
    else replies.push(message)
  }
})
const waitReply = async () => { while (replies.length === 0) await new Promise((r) => setTimeout(r, 10)); return replies.shift() }
const done = (eventId, value) => send({ type: 'done', eventId, ok: true, value, logs: [], usage: { cpuMs: 1, calls: 1 } })
${body}
send({ type: 'ready' })
`
  fs.writeFileSync(file, source)
  return file
}

const modes: Isolation[] = isolation().isolation === 'bwrap' ? ['node', 'bwrap'] : ['node']

describe('the mod logic sandbox', () => {
  it.each(modes)('gives logic no Node, network, timers or other runtime globals, under %s', async (mode) => {
    const result = await pool({ isolation: mode }).run(
      job(
        logic(`
          const names = ['process', 'require', 'fetch', 'XMLHttpRequest', 'WebSocket', 'setTimeout', 'Deno', 'Bun', 'std', 'os']
          const types = Object.fromEntries(names.map((name) => [name, typeof globalThis[name]]))
          let dynamic
          try { await import('node:fs'); dynamic = 'loaded' } catch (e) { dynamic = 'refused' }
          return { types, dynamic }
        `),
      ),
    )
    expect(result).toMatchObject({
      ok: true,
      value: {
        types: {
          process: 'undefined',
          require: 'undefined',
          fetch: 'undefined',
          XMLHttpRequest: 'undefined',
          WebSocket: 'undefined',
          setTimeout: 'undefined',
          Deno: 'undefined',
          Bun: 'undefined',
          std: 'undefined',
          os: 'undefined',
        },
        dynamic: 'refused',
      },
    })
  })

  it('refuses a module that imports anything', async () => {
    const result = await pool().run(job(`import fs from 'node:fs'\n${logic('return fs')}`))
    expect(result).toMatchObject({ ok: false, error: { code: 'failed' } })
    expect(calls).toEqual([])
  })

  it('takes away eval and every Function constructor, even ones captured at load', async () => {
    const result = await pool().run(
      job(
        logic(
          `
          const attempts = {
            eval: () => eval('1'),
            indirect: () => (0, globalThis.eval)('1'),
            function: () => new Function('return 1'),
            captured: () => Captured('return 1'),
            async: () => (async () => {}).constructor('x'),
            generator: () => (function* () {}).constructor('x'),
            asyncGenerator: () => (async function* () {}).constructor('x'),
            call: () => Function.prototype.constructor.call(null, 'x'),
            reflect: () => Reflect.construct(Object.getPrototypeOf(() => {}).constructor, ['x']),
            restore: () => { Function.prototype.constructor = 1; return Function.prototype.constructor },
          }
          return Object.fromEntries(Object.entries(attempts).map(([name, attempt]) => {
            try { attempt(); return [name, 'ran'] } catch (e) { return [name, e.name + ': ' + e.message] }
          }))
        `,
          'const Captured = Function',
        ),
      ),
    )
    expect(result.ok).toBe(true)
    const refusals = Object.values(result.ok ? (result.value as Record<string, string>) : {})
    expect(refusals).toHaveLength(10)
    for (const refusal of refusals) {
      expect(refusal).not.toBe('ran')
      expect(refusal).toMatch(/TypeError|ReferenceError/)
    }
  })

  it('stops a busy loop at the compute slice and runs the next event in the same child', async () => {
    const shared = pool()
    const looped = await shared.run(job(logic('for (;;) {}')))
    expect(looped).toMatchObject({
      ok: false,
      error: { code: 'limit', message: 'The script computed for over 500 ms without awaiting' },
    })
    const [pid] = shared.pids()
    expect(await shared.run(job(logic('return 1')))).toMatchObject({ ok: true, value: 1 })
    expect(shared.pids()).toEqual([pid])
  })

  it('stops a memory bomb at 32 MB and runs the next event', async () => {
    const shared = pool()
    const bomb = await shared.run(job(logic(`const a = []; for (;;) a.push('x'.repeat(1e6) + a.length)`)))
    expect(bomb).toMatchObject({ ok: false, error: { code: 'limit', message: 'The script ran out of memory (32 MB)' } })
    expect(await shared.run(job(logic('return 2')))).toMatchObject({ ok: true, value: 2 })
  })

  it('reports deep recursion as the error', async () => {
    const result = await pool().run(job(logic('const deep = (n) => deep(n + 1) + 1; return deep(0)')))
    expect(result).toMatchObject({ ok: false, error: { code: 'failed' } })
    expect(result.ok ? '' : result.error.message).toMatch(/RangeError|stack overflow/i)
  })

  it('stops a microtask flood by compute', async () => {
    const result = await pool().run(job(logic('for (;;) await null')))
    expect(result).toMatchObject({ ok: false, error: { code: 'limit' } })
    expect(result.ok ? '' : result.error.message).toMatch(/computed for over|used over|ran over/)
  })

  it('refuses the 51st call of an event', async () => {
    const result = await pool().run(
      job(
        logic(`
          const codes = []
          for (let i = 0; i < 51; i++) {
            try { await seti.settings.get(); codes.push('ok') } catch (e) { codes.push(e.code) }
          }
          return codes
        `),
      ),
    )
    const codes = result.ok ? (result.value as string[]) : []
    expect(codes.slice(0, 50).every((code) => code === 'ok')).toBe(true)
    expect(codes[50]).toBe('limit')
  })

  it('refuses a 70 KB call in the child, so Seti never reads it', async () => {
    calls.length = 0
    const result = await pool().run(
      job(logic(`try { await seti.storage.set('k', 'x'.repeat(70 * 1024)) } catch (e) { return [e.code, e.message] }`)),
    )
    expect(result).toMatchObject({ ok: true, value: ['limit', "A call's arguments are at most 64 KB as JSON"] })
    expect(calls).toEqual([])
  })

  it('refuses an oversized call line from a patched runner without parsing it', async () => {
    const runner = patchedRunner(`
      onEvent = async (event) => {
        send('{"type":"call","eventId":"' + event.eventId + '","callId":1,"op":"storage.set","args":{"key":"k","value":"' + 'x'.repeat(70 * 1024) + '"}}')
        done(event.eventId, await waitReply())
      }`)
    const parse = vi.spyOn(JSON, 'parse')
    calls.length = 0
    const result = await pool({ entry: { runner } }).run(job('unused'))
    const parsedLong = parse.mock.calls.some(([text]) => typeof text === 'string' && text.length > 64 * 1024)
    parse.mockRestore()
    expect(parsedLong).toBe(false)
    expect(calls).toEqual([])
    expect(result).toMatchObject({ ok: true, value: { type: 'reply', callId: 1, ok: false, error: { code: 'limit' } } })
  })

  it('retires a child that writes a malformed line, before any op runs', async () => {
    const runner = patchedRunner(`onEvent = (event) => { send('{"type":"call","eventId":'); done(event.eventId, 1) }`)
    calls.length = 0
    const shared = pool({ entry: { runner } })
    const result = await shared.run(job('unused'))
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'failed', message: 'The mod runner wrote a line that is not JSON' },
    })
    expect(calls).toEqual([])
  })

  it('holds a patched runner to the output cap', async () => {
    const runner = patchedRunner(`onEvent = (event) => done(event.eventId, 'x'.repeat(200 * 1024))`)
    expect(await pool({ entry: { runner } }).run(job('unused'))).toMatchObject({
      ok: false,
      error: { code: 'limit', message: 'The script returned over 64 KB' },
    })
  })

  it('retires a child whose call claims a mod, grants or a caller', async () => {
    const runner = patchedRunner(`
      onEvent = (event) => {
        send({ type: 'call', eventId: event.eventId, callId: 1, op: 'storage.get', args: { key: 'k' }, modId: 'other', grants: ['files.read'] })
      }`)
    calls.length = 0
    const result = await pool({ entry: { runner } }).run(job('unused'))
    expect(result).toMatchObject({
      ok: false,
      error: { message: 'The mod runner wrote a message Seti does not accept' },
    })
    expect(calls).toEqual([])
  })

  it('refuses a call for another mod in its arguments, and one for another event', async () => {
    const runner = patchedRunner(`
      onEvent = async (event) => {
        send({ type: 'call', eventId: event.eventId, callId: 1, op: 'storage.get', args: { key: 'k', modId: 'other' } })
        const forged = await waitReply()
        send({ type: 'call', eventId: 'event-of-another-mod', callId: 2, op: 'storage.get', args: { key: 'k' } })
        const other = await waitReply()
        send({ type: 'call', eventId: event.eventId, callId: 3, op: 'files.read', args: { agentId: 'a', path: '.env' } })
        const ungranted = await waitReply()
        send({ type: 'call', eventId: event.eventId, callId: 4, op: 'process.spawn', args: {} })
        const unknown = await waitReply()
        done(event.eventId, [forged, other, ungranted, unknown].map((reply) => reply.error))
      }`)
    calls.length = 0
    const result = await pool({ entry: { runner } }).run(job('unused'))
    expect(result).toMatchObject({
      ok: true,
      value: [
        { code: 'invalid', message: expect.stringContaining('modId') as string },
        { code: 'denied', message: 'This call belongs to no running event' },
        { code: 'denied', message: 'hostile was not granted files.read' },
        { code: 'denied', message: 'Mods cannot call process.spawn' },
      ],
    })
    expect(calls).toEqual([])
  })

  it('kills a child over its memory cap by its exact process id and replaces it', async () => {
    const runner = patchedRunner(`
      const kept = []
      onEvent = (event) => { if (event.script === 'hog') for (let i = 0; i < 40; i++) kept.push(Buffer.alloc(8 * 1024 * 1024, 1)); else done(event.eventId, 'fine') }`)
    const shared = pool({ entry: { runner }, rssBytes: 150 * 1024 * 1024 })
    const first = await shared.run(job('fine'))
    expect(first).toMatchObject({ ok: true, value: 'fine' })
    const [pid] = shared.pids()
    const hog = await shared.run(job('hog'))
    expect(hog).toMatchObject({
      ok: false,
      error: { code: 'limit', message: 'The mod runner used over 150 MB of memory' },
    })
    await vi.waitFor(() => {
      expect(() => process.kill(pid ?? 0, 0)).toThrow()
    })
    expect(await shared.run(job('fine'))).toMatchObject({ ok: true, value: 'fine' })
    expect(shared.pids()).not.toContain(pid)
  })

  it("never runs one mod's event in a child that ran another mod", async () => {
    const shared = pool()
    const script = 'export default { commands: { go: () => 1 } }'
    expect(await shared.run(job(script))).toMatchObject({ ok: true })
    const [first] = shared.pids()
    const other = job(script)
    expect(await shared.run({ ...other, run: { ...other.run, modId: 'neighbour' } })).toMatchObject({ ok: true })
    const [second] = shared.pids()
    expect(second).not.toBe(first)
    expect(() => process.kill(first ?? 0, 0)).toThrow()
    expect(await shared.run({ ...other, run: { ...other.run, modId: 'neighbour', eventId: 'again' } })).toMatchObject({
      ok: true,
    })
    expect(shared.pids()).toEqual([second])
  })

  it('keeps nothing from one event to the next but storage', async () => {
    const shared = pool()
    const script = logic(
      `
      const seen = { counter: ++counter, global: globalThis.kept ?? null, proto: ({}).planted ?? null }
      globalThis.kept = 'kept'
      Object.prototype.planted = 'planted'
      return seen
    `,
      'let counter = 0',
    )
    expect(await shared.run(job(script))).toMatchObject({ ok: true, value: { counter: 1, global: null, proto: null } })
    expect(await shared.run(job(script))).toMatchObject({ ok: true, value: { counter: 1, global: null, proto: null } })
  })

  // bwrap sets PWD to / as it changes into it, which names no host path.
  it.each(modes)('gives a runner no files, environment, processes or workers, under %s', async (mode) => {
    const runner = patchedRunner(`
      import { spawnSync } from 'node:child_process'
      import { Worker } from 'node:worker_threads'
      const attempt = (fn) => { try { fn(); return 'ran' } catch (e) { return e.code ?? e.message } }
      onEvent = (event) => done(event.eventId, {
        hostFile: attempt(() => fs.readFileSync('/etc/hostname', 'utf8')),
        env: Object.keys(process.env).filter((name) => name !== 'PWD'),
        spawn: attempt(() => spawnSync('/bin/true')),
        worker: attempt(() => new Worker('0', { eval: true })),
      })`)
    const result = await pool({ entry: { runner }, isolation: mode }).run(job('unused'))
    expect(result).toMatchObject({
      ok: true,
      value: { hostFile: 'ERR_ACCESS_DENIED', env: [], spawn: 'ERR_ACCESS_DENIED', worker: 'ERR_ACCESS_DENIED' },
    })
  })

  it.runIf(modes.includes('bwrap'))('runs the child in its own network namespace with no way out', async () => {
    const server = net.createServer((socket) => socket.end('seti'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as net.AddressInfo
    const runner = patchedRunner(`
      import net from 'node:net'
      onEvent = (event) => {
        const socket = net.connect(${String(port)}, '127.0.0.1')
        socket.on('connect', () => done(event.eventId, 'connected'))
        socket.on('error', (e) => done(event.eventId, e.code))
      }`)
    const shared = pool({ entry: { runner }, isolation: 'bwrap' })
    const result = await shared.run(job('unused'))
    server.close()
    expect(result.ok && result.value).not.toBe('connected')
    const leaf = (pid: number): number => {
      const children = fs.readFileSync(`/proc/${String(pid)}/task/${String(pid)}/children`, 'utf8').trim()
      return children === '' ? pid : leaf(Number(children.split(' ')[0]))
    }
    const [pid] = shared.pids()
    const namespace = fs.readlinkSync(`/proc/${String(leaf(pid ?? 0))}/ns/net`)
    expect(namespace).not.toBe(fs.readlinkSync('/proc/self/ns/net'))
  })
})
