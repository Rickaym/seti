import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import { execute } from './execute.js'
import { createPollerPool, type PollerPool, type PollRequest } from './pool.js'

const SECRET = ['poller', 'test', 'secret', 'pool'].join('-')

const request = (script: string): PollRequest => ({
  script,
  input: { state: null, since: null },
  limits: {
    timeoutMs: 60_000,
    memoryBytes: 48 * 1024 * 1024,
    cpuSliceMs: 60_000,
    cpuTotalMs: 60_000,
    fetches: 1,
    logLines: 5,
    logLineChars: 100,
    outputBytes: 64 * 1024,
  },
  fetch: {
    allowed: [],
    responseMaxBytes: 1024,
    runResponseMaxBytes: 4096,
    requestBodyMaxBytes: 1024,
    timeoutMs: 1000,
    allowLoopback: false,
  },
  fingerprintFields: [],
  secrets: [['token', SECRET]],
})

/** A stand-in worker: `crash` throws with the secrets it was sent, `hog` fills its heap. */
const MISBEHAVING_SOURCE = `
import { parentPort } from 'node:worker_threads'
parentPort.on('message', (run) => {
  if (run.script === 'crash') throw new Error('boom ' + run.secrets.map((pair) => pair[1]).join(','))
  if (run.script === 'hog') { const kept = []; for (;;) kept.push(new Array(100000).fill(run.script)) }
  const output = { items: [], invalid: [], complete: true, state: undefined }
  parentPort.postMessage({ type: 'result', runId: run.runId, result: { ok: true, output, logs: [run.script] } })
})
parentPort.postMessage({ type: 'ready' })
`
const MISBEHAVING = new URL(`data:text/javascript,${encodeURIComponent(MISBEHAVING_SOURCE)}`)
const SILENT = new URL('data:text/javascript,setInterval(() => {}, 1000)')

const pools: PollerPool[] = []
const pool = (options: Partial<Parameters<typeof createPollerPool>[0]> = {}) => {
  const created = createPollerPool({ size: 1, resourceLimits: {}, startupMs: 30_000, ...options })
  pools.push(created)
  return created
}

afterAll(async () => {
  await Promise.all(pools.map(async (created) => created.close()))
})

describe('poller pool', () => {
  it('runs polls in a worker that keeps nothing from one run to the next', async () => {
    const workers = pool()
    const first = await workers.run(request('export default () => { globalThis.seen = 1; return [] }'), 30_000)
    const second = await workers.run(request('export default () => [{ key: String(globalThis.seen) }]'), 30_000)
    expect(first).toMatchObject({ ok: true, output: { items: [] } })
    expect(second).toMatchObject({ ok: true, output: { items: [{ key: 'undefined' }] } })
    expect(workers.threadIds()).toHaveLength(1)
  })

  it('stops a worker whose run passes its wall clock and starts a new one for the next run', async () => {
    const workers = pool()
    await workers.run(request('export default () => []'), 30_000)
    const [before] = workers.threadIds()
    const started = Date.now()
    await expect(workers.run(request('export default () => { for (;;) {} }'), 500)).rejects.toThrow(
      'The script ran over its 60 s timeout and its worker was stopped',
    )
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(workers.threadIds()).toEqual([])
    expect(await workers.run(request('export default () => []'), 30_000)).toMatchObject({ ok: true })
    expect(workers.threadIds()).toHaveLength(1)
    expect(workers.threadIds()).not.toContain(before)
  })

  it('fails only the run of a worker that crashes, and replaces the worker', async () => {
    const workers = pool({ entry: MISBEHAVING })
    const runs = await Promise.allSettled(
      ['one', 'crash', 'two'].map(async (script) => workers.run(request(script), 30_000)),
    )
    expect(runs.map((run) => (run.status === 'fulfilled' ? run.value.logs[0] : String(run.reason)))).toEqual([
      'one',
      `Error: The poller worker failed and was replaced: boom ${SECRET}`,
      'two',
    ])
  })

  it('answers plainly when the engine traps on a response, and replaces that worker', async () => {
    const server = http.createServer((_req, res) => res.end('x'.repeat(1024 * 1024)))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const host = `127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const workers = pool()
    await workers.run(request('export default () => []'), 30_000)
    const [before] = workers.threadIds()
    const filling = request(`export default async ({ fetch }) => {
      const filled = []
      try {
        for (;;) filled.push('x'.repeat(100000) + filled.length)
      } catch {
        filled.pop()
      }
      return [{ key: String((await (await fetch('http://${host}/')).text()).length) }]
    }`)
    const fetch = { ...filling.fetch, allowed: [host], allowLoopback: true, responseMaxBytes: 2 * 1024 * 1024 }
    const run = await workers.run(
      { ...filling, fetch: { ...fetch, runResponseMaxBytes: fetch.responseMaxBytes } },
      30_000,
    )
    server.close()
    expect(run).toEqual({ ok: false, error: 'The script ran out of memory (48 MB)', logs: [] })
    expect(workers.threadIds()).toEqual([])
    expect(await workers.run(request('export default () => []'), 30_000)).toMatchObject({ ok: true })
    expect(workers.threadIds()).not.toContain(before)
  })

  it('fails the run of a worker that runs out of heap', async () => {
    const workers = pool({ entry: MISBEHAVING, resourceLimits: { maxOldGenerationSizeMb: 16 } })
    await expect(workers.run(request('hog'), 30_000)).rejects.toThrow(
      'The poller worker ran out of memory and was replaced',
    )
    expect(await workers.run(request('after'), 30_000)).toMatchObject({ ok: true, logs: ['after'] })
  })

  it('fails the run of a worker that does not start, and refuses runs once closed', async () => {
    const workers = pool({ entry: SILENT, startupMs: 300 })
    await expect(workers.run(request('never'), 30_000)).rejects.toThrow('The poller worker did not start within 0.3 s')
    await workers.close()
    await expect(workers.run(request('late'), 30_000)).rejects.toThrow('Seti is stopping')
  })

  it('keeps secret values out of the error of a worker that crashed', async () => {
    const run = await execute(
      { script: 'crash', timeout_s: 10, extra_hosts: [], secrets: ['token'], fingerprint_fields: [] },
      { state: null, since: null },
      {
        allowedHosts: async () => Promise.resolve([]),
        secretValues: async () => Promise.resolve(new Map([['token', SECRET]])),
        allowLoopback: false,
        workers: pool({ entry: MISBEHAVING }),
      },
    )
    expect(run).toMatchObject({ ok: false, error: 'The poller worker failed and was replaced: boom [secret]' })
    expect(JSON.stringify(run)).not.toContain(SECRET)
  })
})
