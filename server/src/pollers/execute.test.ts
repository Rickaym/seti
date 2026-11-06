import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execute, type ExecuteDeps } from './execute.js'
import { createPollerPool } from './pool.js'

const SECRET = ['poller', 'test', 'secret', 'execute'].join('-')

let server: http.Server
let host = ''

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ items: [{ id: 7, name: 'Seven' }], auth: req.headers.authorization ?? null }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  host = `127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

const workers = createPollerPool({ size: 1, resourceLimits: {}, startupMs: 30_000 })

afterAll(async () => {
  server.close()
  await workers.close()
})

const deps: ExecuteDeps = {
  allowedHosts: async () => Promise.resolve([]),
  secretValues: async (refs) =>
    Promise.resolve(
      new Map(
        refs.map((ref) => {
          if (ref !== 'api_key') {
            throw new Error(`The secret ${ref} is not set; set it in Settings, Credentials`)
          }
          return [ref, SECRET]
        }),
      ),
    ),
  allowLoopback: true,
  workers,
}

const settings = (script: string, extra: { secrets?: string[]; hosts?: string[] } = {}) => ({
  script,
  timeout_s: 10,
  extra_hosts: extra.hosts ?? [host],
  secrets: extra.secrets ?? ['api_key'],
  fingerprint_fields: [],
})

const CONTEXT = { state: null, since: null }

describe('execute', () => {
  it('runs a poll script against an allowed host and reads its items', async () => {
    const run = await execute(
      settings(`export default async function poll({ fetch }) {
        const data = await (await fetch('http://${host}/items')).json()
        return data.items.map((item) => ({ key: item.id, title: item.name }))
      }`),
      CONTEXT,
      deps,
    )
    expect(run).toMatchObject({ ok: true, output: { items: [{ key: '7', title: 'Seven' }], complete: true } })
  })

  it('never lets the secret reach the script, its logs, its items or its errors', async () => {
    const run = await execute(
      settings(`export default async function poll({ fetch, log }) {
        const res = await fetch('http://${host}/items', { secretHeaders: { Authorization: 'Bearer {{api_key}}' } })
        const text = await res.text()
        log('echo', text)
        return [{ key: 'echo', title: JSON.parse(text).auth, body: text }]
      }`),
      CONTEXT,
      deps,
    )
    expect(run.ok).toBe(true)
    expect(JSON.stringify(run)).not.toContain(SECRET)
    expect(JSON.stringify(run)).toContain('Bearer [secret]')

    const failed = await execute(
      settings(`export default async function poll({ fetch }) {
        const res = await fetch('http://${host}/items', { secretHeaders: { Authorization: '{{api_key}}' } })
        throw new Error(await res.text())
      }`),
      CONTEXT,
      deps,
    )
    expect(failed.ok).toBe(false)
    expect(JSON.stringify(failed)).not.toContain(SECRET)
  })

  it('fails the run when a named secret is not set, or a host is not allowed', async () => {
    const missing = await execute(settings('export default () => []', { secrets: ['other'] }), CONTEXT, deps)
    expect(missing).toMatchObject({
      ok: false,
      error: 'The secret other is not set; set it in Settings, Credentials',
    })
    const refused = await execute(
      settings(`export default async ({ fetch }) => { await fetch('http://${host}/'); return [] }`, { hosts: [] }),
      CONTEXT,
      deps,
    )
    expect(refused.ok ? '' : refused.error).toContain('is not on the allowed hosts')
  })

  it('hands the stored state in and takes the new one back', async () => {
    const run = await execute(
      settings('export default ({ state }) => ({ items: [], state: { runs: (state?.runs ?? 0) + 1 } })'),
      { state: { runs: 4 }, since: null },
      deps,
    )
    expect(run).toMatchObject({ ok: true, output: { state: { runs: 5 } } })
  })

  it('tells a run Seti stopped as it shut down from one that failed', async () => {
    const closing = createPollerPool({ size: 1, resourceLimits: {}, startupMs: 30_000 })
    const slow = execute(settings('export default () => new Promise(() => {})'), CONTEXT, { ...deps, workers: closing })
    await new Promise((resolve) => setTimeout(resolve, 200))
    await closing.close()
    expect(await slow).toMatchObject({ ok: false, interrupted: true })
    const after = await execute(settings('export default () => []'), CONTEXT, { ...deps, workers: closing })
    expect(after).toMatchObject({ ok: false, interrupted: true, error: 'Seti is stopping; the run did not start' })
    const broken = await execute(settings('export default () => { throw new Error("no") }'), CONTEXT, deps)
    expect(broken).not.toHaveProperty('interrupted')
  })
})
