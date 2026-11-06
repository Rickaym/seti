import { describe, expect, it, vi } from 'vitest'
import { runScript, type EngineHost, type EngineLimits, type EngineOutcome } from './engine.js'

const LIMITS: EngineLimits = {
  timeoutMs: 5000,
  memoryBytes: 48 * 1024 * 1024,
  cpuSliceMs: 500,
  cpuTotalMs: 3000,
  fetches: 3,
  logLines: 5,
  logLineChars: 40,
  outputBytes: 64 * 1024,
}

const NO_HOST: EngineHost = {
  fetch: async () => Promise.reject(new Error('no network in this test')),
  parseFeed: () => [],
}

const errorOf = (outcome: EngineOutcome) => (outcome.ok ? '' : outcome.error)

const run = async (script: string, host = NO_HOST, limits = LIMITS, state: unknown = null) =>
  runScript(script, { state, since: '2026-09-30T00:00:00.000Z' }, host, limits)

describe('runScript', () => {
  it('returns what the default export resolves to, with the input it was given', async () => {
    const outcome = await run(
      `export default async function poll({ state, since }) {
        return { items: [{ key: 'a', title: since }], state: { seen: (state?.seen ?? 0) + 1 } }
      }`,
      NO_HOST,
      LIMITS,
      { seen: 2 },
    )
    expect(outcome).toEqual({
      ok: true,
      value: { items: [{ key: 'a', title: '2026-09-30T00:00:00.000Z' }], state: { seen: 3 } },
      logs: [],
    })
  })

  it('waits for top-level await before calling the poll function', async () => {
    const outcome = await run('const n = await Promise.resolve(3)\nexport default () => [{ key: String(n) }]')
    expect(outcome).toMatchObject({ ok: true, value: [{ key: '3' }] })
  })

  it('has no require, process, fs import, timers or host globals', async () => {
    const outcome = await run(
      `export default function poll() {
        return [typeof require, typeof process, typeof setTimeout, typeof fetch, typeof globalThis.__host,
          typeof Buffer, typeof module]
      }`,
    )
    expect(outcome).toMatchObject({ ok: true, value: Array(7).fill('undefined') })
    const imported = await run(`import fs from 'fs'\nexport default () => []`)
    expect(errorOf(imported)).toContain("could not load module 'fs'")
  })

  it('stops an endless loop, and a script that computes too long without awaiting', async () => {
    const endless = await run('export default function poll() { for (;;) {} }')
    expect(errorOf(endless)).toBe('The script computed for over 500 ms without awaiting')
  })

  it('stops a script that awaits forever at its timeout', async () => {
    const outcome = await run('export default () => new Promise(() => {})', NO_HOST, { ...LIMITS, timeoutMs: 300 })
    expect(outcome).toMatchObject({ ok: false, error: 'The script ran over its 0.3 s timeout' })
  })

  it('stops a script that runs out of memory', async () => {
    const outcome = await run(
      "export default () => { const a = []; for (let i = 0; ; i++) a.push('x'.repeat(1000) + i) }",
      NO_HOST,
      { ...LIMITS, memoryBytes: 24 * 1024 * 1024, cpuSliceMs: 5000, cpuTotalMs: 5000 },
    )
    expect(outcome).toMatchObject({ ok: false, error: 'The script ran out of memory (24 MB)' })
  })

  it('reports thrown errors with their line, and a missing default export', async () => {
    expect(await run("export default () => {\n  throw new Error('boom')\n}")).toMatchObject({
      ok: false,
      error: 'Error: boom (line 2)',
    })
    expect(errorOf(await run('export const x = 1'))).toContain('Export the poll')
    expect(errorOf(await run('export default ('))).toContain('SyntaxError')
  })

  it('fetches through the host and wraps the answer like a Response', async () => {
    const fetch = vi.fn(async () =>
      Promise.resolve({
        status: 200,
        url: 'https://x.test/a',
        headers: [['content-type', 'application/json']] as [string, string][],
        body: '{"n":1}',
      }),
    )
    const outcome = await run(
      `export default async function poll({ fetch }) {
        const res = await fetch('https://x.test/a', { secretHeaders: { Authorization: 'Bearer {{t}}' } })
        return [{ key: String((await res.json()).n), title: res.headers.get('Content-Type'), ok: res.ok }]
      }`,
      { ...NO_HOST, fetch },
    )
    expect(outcome).toMatchObject({ ok: true, value: [{ key: '1', title: 'application/json', ok: true }] })
    expect(fetch).toHaveBeenCalledWith(
      { url: 'https://x.test/a', init: { secretHeaders: { Authorization: 'Bearer {{t}}' } } },
      expect.any(AbortSignal),
    )
  })

  it('turns host errors into rejections the script can catch, and caps requests', async () => {
    const outcome = await run(
      `export default async function poll({ fetch }) {
        const errors = []
        for (let i = 0; i < 4; i++) {
          try { await fetch('https://x.test/' + i) } catch (e) { errors.push(e.message) }
        }
        return errors
      }`,
    )
    expect(outcome).toMatchObject({
      ok: true,
      value: [
        'no network in this test',
        'no network in this test',
        'no network in this test',
        'A run makes at most 3 requests',
      ],
    })
  })

  it('keeps a capped log and parses feeds on the host', async () => {
    const outcome = await run(
      `export default function poll({ log, parseFeed }) {
        for (let i = 0; i < 8; i++) log('line', i, { i })
        log('x'.repeat(100))
        return parseFeed('<rss/>')
      }`,
      { ...NO_HOST, parseFeed: () => [{ id: 'e1' }] },
    )
    expect(outcome).toMatchObject({ ok: true, value: [{ id: 'e1' }] })
    expect(outcome.logs).toEqual([
      'line 0 {"i":0}',
      'line 1 {"i":1}',
      'line 2 {"i":2}',
      'line 3 {"i":3}',
      'line 4 {"i":4}',
    ])
  })

  it('refuses output over its size limit', async () => {
    const outcome = await run("export default () => [{ key: 'a', body: 'x'.repeat(100000) }]")
    expect(outcome).toMatchObject({ ok: false, error: 'The script returned over 64 KB' })
  })

  describe('memory', () => {
    const MB = 1024 * 1024
    const ROOMY = { ...LIMITS, cpuSliceMs: 10_000, cpuTotalMs: 20_000 }
    const serving = (body: string): EngineHost => ({
      ...NO_HOST,
      fetch: async () => Promise.resolve({ status: 200, url: 'https://x.test/', headers: [], body }),
    })

    it('keeps MBs of two-byte text after an await, where the engine collects garbage mid-job', async () => {
      const outcome = await run(
        `export default async ({ fetch }) => {
          const kept = []
          for (let i = 0; i < 3; i++) kept.push(await (await fetch('https://x.test/')).text())
          const objects = []
          for (let i = 0; i < 200000; i++) objects.push({ i })
          return [{ key: String(kept.reduce((n, t) => n + t.length, 0) + objects.length) }]
        }`,
        serving(`${String.fromCodePoint(0x20ac)}${'x'.repeat(4 * MB - 3)}`),
        ROOMY,
      )
      expect(outcome).toMatchObject({ ok: true, value: [{ key: String(3 * (4 * MB - 2) + 200000) }] })
    })

    it('says the script ran out of memory when QuickJS has no room left for the error', async () => {
      const item = JSON.stringify({ id: 12345, name: 'item name', state: 'open' })
      const items = Array.from({ length: Math.floor((14 * MB) / (item.length + 1)) }, () => item)
      const outcome = await run(
        "export default async ({ fetch }) => [{ key: String((await (await fetch('https://x.test/')).json()).length) }]",
        serving(`[${items.join(',')}]`),
        ROOMY,
      )
      expect(outcome).toEqual({ ok: false, error: 'The script ran out of memory (48 MB)', logs: [] })
    })

    it('ends the run as out of memory when the engine traps taking in a response', async () => {
      const outcome = await run(
        `export default async ({ fetch }) => {
          const filled = []
          try {
            for (;;) filled.push('x'.repeat(100000) + filled.length)
          } catch {
            filled.pop()
          }
          return [{ key: String((await (await fetch('https://x.test/')).text()).length + filled.length) }]
        }`,
        serving('x'.repeat(4 * MB)),
        ROOMY,
      )
      expect(outcome).toEqual({ ok: false, error: 'The script ran out of memory (48 MB)', logs: [], aborted: true })
    })
  })
})
