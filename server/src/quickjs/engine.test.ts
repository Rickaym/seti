import { describe, expect, it } from 'vitest'
import { runModule, type HostFunction, type ModuleEntry, type ModuleLimits } from './engine.js'

const LIMITS: ModuleLimits = {
  timeoutMs: 5000,
  memoryBytes: 32 * 1024 * 1024,
  cpuSliceMs: 500,
  cpuTotalMs: 3000,
  logLines: 2,
  logLineChars: 20,
  outputBytes: 1024,
}

/** A handler object, called by name through a prelude, as mod logic is. */
const HANDLERS: ModuleEntry = {
  file: 'logic.js',
  prelude: `(host, input, handlers) => {
    const { name, args } = JSON.parse(input)
    const call = async (op) => JSON.parse(await host.call(JSON.stringify({ op })))
    return handlers[name](args, { call, log: (text) => host.log(text) })
  }`,
  main: { type: 'object', missing: 'logic.js has no handlers' },
}

const echo: HostFunction = { kind: 'async', call: async (arg) => Promise.resolve(JSON.stringify({ got: arg })) }

const run = async (script: string, input: unknown, host: Record<string, HostFunction> = { call: echo }) =>
  runModule({ script, entry: HANDLERS, input, host, limits: LIMITS })

describe('runModule', () => {
  it('calls into an object export through the prelude, with async host calls and capped logs', async () => {
    const outcome = await run(
      `export default {
        link: async (args, seti) => {
          seti.log('first line, which is longer than twenty')
          seti.log('second'); seti.log('third')
          return { args, reply: await seti.call('storage.get') }
        },
      }`,
      { name: 'link', args: { id: 7 } },
    )
    expect(outcome).toMatchObject({
      ok: true,
      value: { args: { id: 7 }, reply: { got: '{"op":"storage.get"}' } },
      logs: ['first line, which...', 'second'],
    })
    expect(outcome.cpuMs).toBeGreaterThanOrEqual(0)
  })

  it('hands a flat record over prop by prop, and a rejected host call as an Error', async () => {
    const record: HostFunction = { kind: 'async', call: async () => Promise.resolve({ status: 200, body: 'ok' }) }
    const direct = { ...HANDLERS, prelude: `(host) => host.call('x')` }
    const shaped = await runModule({
      script: 'export default {}',
      entry: direct,
      input: null,
      host: { call: record },
      limits: LIMITS,
    })
    expect(shaped).toMatchObject({ ok: true, value: { status: 200, body: 'ok' } })
    const refuse: HostFunction = { kind: 'async', call: async () => Promise.reject(new Error('denied: not granted')) }
    const script = `export default { ask: async (args, seti) => seti.call('x') }`
    const refused = await run(script, { name: 'ask', args: null }, { call: refuse })
    expect(refused).toMatchObject({ ok: false, error: 'Error: denied: not granted' })
  })

  it('names the module file in error lines and refuses a missing export', async () => {
    const thrown = await run(`export default {\n  boom: () => {\n    throw new TypeError('bad')\n  },\n}`, {
      name: 'boom',
      args: null,
    })
    expect(thrown).toMatchObject({ ok: false, error: 'TypeError: bad (line 3)' })
    expect(await run('export default 1', { name: 'x' })).toMatchObject({ ok: false, error: 'logic.js has no handlers' })
  })

  it('stops a loop that never awaits and keeps the output cap', async () => {
    const spin = await run('export default { spin: () => { for (;;) {} } }', { name: 'spin' })
    expect(spin).toMatchObject({ ok: false, error: 'The script computed for over 500 ms without awaiting' })
    const big = await run(`export default { big: () => 'x'.repeat(2000) }`, { name: 'big' })
    expect(big).toMatchObject({ ok: false, error: 'The script returned over 1 KB' })
  })

  it('runs the lockdown before the module, and marks a limit apart from a script error', async () => {
    const locked = { ...HANDLERS, lockdown: 'globalThis.marker = Object.freeze({ by: "lockdown" })' }
    const seen = await runModule({
      script: 'const atLoad = globalThis.marker\nexport default { see: () => atLoad }',
      entry: locked,
      input: { name: 'see' },
      host: { call: echo },
      limits: LIMITS,
    })
    expect(seen).toMatchObject({ ok: true, value: { by: 'lockdown' } })
    const spin = await run('export default { spin: () => { for (;;) {} } }', { name: 'spin' })
    expect(spin).toMatchObject({ ok: false, limit: true })
    const thrown = await run(`export default { boom: () => { throw new Error('no') } }`, { name: 'boom' })
    expect(thrown).not.toHaveProperty('limit')
  })

  it('ends a run whose recursion exhausts the stack with an error, never a throw', async () => {
    const deep = await run('export default { deep: () => { const f = (n) => f(n + 1) + 1; return f(0) } }', {
      name: 'deep',
    })
    expect(deep).toMatchObject({ ok: false, error: expect.stringMatching(/RangeError|stack overflow/i) as string })
    if (!deep.ok && deep.error.startsWith('RangeError')) {
      expect(deep.aborted).toBe(true)
    }
  })
})
