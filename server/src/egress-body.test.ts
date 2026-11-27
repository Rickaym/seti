import type { OutgoingHttpHeaders } from 'node:http'
import { PassThrough, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { describe, expect, it } from 'vitest'
import { BODY_LIMIT, bodyTypeOf, headersForBody, planBody, watchRest, type BodyPlan } from './egress-body.js'
import type { EgressPlaceholder } from './egress-placeholders.js'

const VALUE = ['pw', 'fake', 'Qx7'].join('-')
const HOLDER = `seti-secret-site_login-${'c3'.repeat(16)}`
const OTHER = `seti-secret-vendor-${'d4'.repeat(16)}`
const HOST = 'app.login.test'
const target = { host: HOST, port: 443 }

const entries: EgressPlaceholder[] = [
  { name: 'site_login', placeholder: HOLDER, hosts: [HOST], body: false, value: async () => Promise.resolve(VALUE) },
  {
    name: 'vendor',
    placeholder: OTHER,
    hosts: ['api.vendor.test'],
    body: false,
    value: async () => Promise.resolve(VALUE),
  },
]

const json = { 'content-type': 'application/json' }

/** A body that arrives in these pieces, as a socket may split it. */
const chunked = (...pieces: string[]) => Readable.from(pieces.map((piece) => Buffer.from(piece)))

const plan = async (headers: Record<string, string>, ...pieces: string[]) =>
  planBody(target, headers, chunked(...pieces), entries)

describe('bodyTypeOf', () => {
  it('reads JSON, forms, multipart and plain text only', () => {
    expect(bodyTypeOf('application/json; charset=utf-8')).toBe('json')
    expect(bodyTypeOf('application/vnd.api+json')).toBe('json')
    expect(bodyTypeOf('application/x-www-form-urlencoded')).toBe('form')
    expect(bodyTypeOf('multipart/form-data; boundary=x')).toBe('multipart')
    expect(bodyTypeOf('Text/Plain')).toBe('text')
    for (const other of ['application/octet-stream', 'text/html', 'image/png', 'application/xml', undefined]) {
      expect(bodyTypeOf(other)).toBeNull()
    }
  })
})

describe('planBody', () => {
  it('streams bodies it does not read: other hosts, other types and encoded bodies', async () => {
    const body = `{"password":"${HOLDER}"}`
    const elsewhere = await planBody({ host: 'other.test', port: 443 }, json, chunked(body), entries)
    expect(elsewhere).toEqual({ kind: 'stream' })
    expect(await plan({ 'content-type': 'application/octet-stream' }, body)).toEqual({ kind: 'stream' })
    expect(await plan({ ...json, 'content-encoding': 'gzip' }, body)).toEqual({ kind: 'stream' })
  })

  it('holds a body without a placeholder whole and sends it as it came', async () => {
    const result = await plan(json, '{"email":"qa@example.test",', '"remember":true}')
    expect(result).toEqual({ kind: 'whole', body: Buffer.from('{"email":"qa@example.test","remember":true}') })
  })

  it("refuses the connection's own placeholder in a body, naming it and never the value", async () => {
    const result = await plan(
      json,
      `{"email":"qa@example.test","password":"${HOLDER.slice(0, 20)}`,
      `${HOLDER.slice(20)}"}`,
    )
    expect(result).toMatchObject({ status: 403, names: ['site_login'] })
    expect(JSON.stringify(result)).toContain('site_login')
    expect(JSON.stringify(result)).toContain('ask the user to turn on Body for that connection')
    expect(JSON.stringify(result)).not.toContain(VALUE)
  })

  it('refuses a placeholder toward a host its connection does not allow, as for headers', async () => {
    const result = await plan({ 'content-type': 'application/x-www-form-urlencoded' }, `key=${OTHER}`)
    expect(result).toMatchObject({ status: 403, names: ['vendor'] })
    expect(JSON.stringify(result)).toContain('only to the hosts the user allowed')
  })

  it('reads at most the limit, then watches the rest; a placeholder within it is refused', async () => {
    const big = 'a'.repeat(BODY_LIMIT)
    const over = await plan({ 'content-type': 'text/plain' }, big, 'tail')
    expect(over).toMatchObject({ kind: 'rest' })
    const carried = await plan({ 'content-type': 'text/plain' }, HOLDER, big)
    expect(carried).toMatchObject({ status: 413, names: ['site_login'] })
  })

  it('answers null when the client goes away before the body ends', async () => {
    const body = new PassThrough()
    const planned = planBody(target, json, body, entries)
    body.write('{"a":')
    body.destroy()
    expect(await planned).toBeNull()
  })
})

describe('planBody with Body on', () => {
  const on: EgressPlaceholder[] = entries.map((entry) => ({ ...entry, body: entry.name === 'site_login' }))
  const planOn = async (headers: Record<string, string>, ...pieces: string[]) =>
    planBody(target, headers, chunked(...pieces), on)

  it('swaps the value into the body, even with the placeholder split across chunks', async () => {
    const body = `{"password":"${HOLDER}"}`
    const result = await planOn(json, body.slice(0, 20), body.slice(20))
    expect(result).toEqual({ kind: 'whole', body: Buffer.from(`{"password":"${VALUE}"}`) })
  })

  it("still refuses another connection's placeholder toward this host", async () => {
    const result = await planOn(json, `{"a":"${HOLDER}","b":"${OTHER}"}`)
    expect(result).toMatchObject({ status: 403, names: ['vendor'] })
    expect(JSON.stringify(result)).not.toContain(VALUE)
  })

  it('refuses a compressed text body on its hosts, since it cannot be searched, and nowhere else', async () => {
    const gzip = { ...json, 'content-encoding': 'gzip' }
    expect(await planOn(gzip, 'compressed')).toMatchObject({ status: 415, names: [] })
    expect(await planOn({ ...gzip, 'content-type': 'application/octet-stream' }, 'x')).toEqual({ kind: 'stream' })
    expect(await plan(gzip, 'compressed')).toEqual({ kind: 'stream' })
  })

  it('refuses a body over the limit that carries the placeholder instead of passing it through', async () => {
    const result = await planOn({ 'content-type': 'text/plain' }, HOLDER, 'a'.repeat(BODY_LIMIT))
    expect(result).toMatchObject({ status: 413, names: ['site_login'] })
  })

  it('answers 502 without a value and records no blocked connection', async () => {
    const empty = on.map((entry) => ({ ...entry, value: async () => Promise.resolve(null) }))
    const result = await planBody(target, json, chunked(`{"p":"${HOLDER}"}`), empty)
    expect(result).toMatchObject({ status: 502, names: [] })
  })
})

describe('watchRest', () => {
  const collect = async (head: string, ...pieces: string[]) => {
    const out: Buffer[] = []
    const sink = new PassThrough()
    sink.on('data', (chunk: Buffer) => out.push(chunk))
    await pipeline(chunked(...pieces), watchRest([Buffer.from(HOLDER)], Buffer.from(head)), sink)
    return Buffer.concat(out).toString()
  }

  it('passes a body without a placeholder on unchanged', async () => {
    expect(await collect('head', 'one', 'two')).toBe('onetwo')
  })

  it('fails on a placeholder split across chunks, and across the edge of the held part', async () => {
    await expect(collect('x', HOLDER.slice(0, 10), HOLDER.slice(10))).rejects.toThrow(/placeholder/)
    await expect(collect(`x${HOLDER.slice(0, 30)}`, HOLDER.slice(30))).rejects.toThrow(/placeholder/)
  })
})

describe('headersForBody', () => {
  const headers: OutgoingHttpHeaders = {
    'content-type': 'application/json',
    'transfer-encoding': 'chunked',
    expect: '100-continue',
  }

  it('gives a held body its exact length and no chunking', () => {
    const whole: BodyPlan = { kind: 'whole', body: Buffer.from(`{"k":"${String.fromCodePoint(0xe9)}"}`) }
    expect(headersForBody(headers, whole)).toEqual({ 'content-type': 'application/json', 'content-length': '10' })
  })

  it('leaves a streamed body as it came', () => {
    expect(headersForBody(headers, { kind: 'stream' })).toBe(headers)
  })
})
