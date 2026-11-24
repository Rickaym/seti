import { describe, expect, it } from 'vitest'
import { swapBody, swapInBody } from './egress-body-swap.js'
import type { EgressPlaceholder } from './egress-placeholders.js'

const HOLDER = `seti-secret-site_login-${'f6'.repeat(16)}`
const TRICKY = `q"uo\\te&a=b+c ${String.fromCodePoint(0x00e9, 0x1f511)}`

const json = { type: 'json', contentType: 'application/json' } as const
const form = { type: 'form', contentType: 'application/x-www-form-urlencoded' } as const
const text = { type: 'text', contentType: 'text/plain' } as const
const multipart = { type: 'multipart', contentType: 'multipart/form-data; boundary=XyZ' } as const

const swap = (body: string, content: Parameters<typeof swapInBody>[1], value = TRICKY) =>
  swapInBody(Buffer.from(body), content, HOLDER, value)?.toString() ?? null

describe('swapInBody', () => {
  it('writes the value into JSON as an escaped string, so the body stays valid JSON', () => {
    const out = swap(`{"email":"qa@example.test","password":"${HOLDER}"}`, json)
    expect(JSON.parse(out ?? '')).toEqual({ email: 'qa@example.test', password: TRICKY })
    expect(JSON.parse(swap(`{"p":"${HOLDER}"}`, json, 'two\nlines\ttab') ?? '')).toEqual({ p: 'two\nlines\ttab' })
  })

  it('URL-encodes the value into a form, so & and = cannot add a field', () => {
    const out = swap(`email=qa%40example.test&password=${HOLDER}`, form)
    expect(Object.fromEntries(new URLSearchParams(out ?? ''))).toEqual({ email: 'qa@example.test', password: TRICKY })
    expect(swap(`p=${HOLDER}`, form, `lone ${String.fromCharCode(0xd800)}`)).toBeNull()
  })

  it('writes plain text raw, every occurrence', () => {
    expect(swap(`${HOLDER} and ${HOLDER}`, text, 'line\none')).toBe('line\none and line\none')
  })

  it('swaps a multipart text field only, never a file, a part header or a value with a line break', () => {
    const field = (name: string, value: string, extra = '') =>
      `--XyZ\r\nContent-Disposition: form-data; name="${name}"${extra}\r\n\r\n${value}\r\n`
    const body = `${field('email', 'qa@example.test')}${field('password', HOLDER)}--XyZ--\r\n`
    expect(swap(body, multipart)).toBe(body.replace(HOLDER, TRICKY))
    expect(swap(`${field('upload', HOLDER, '; filename="a.txt"')}--XyZ--\r\n`, multipart)).toBeNull()
    expect(swap(`${field(HOLDER, 'x')}--XyZ--\r\n`, multipart)).toBeNull()
    const typed = `--XyZ\r\nContent-Disposition: form-data; name="b"\r\nContent-Type: application/octet-stream\r\n\r\n`
    expect(swap(`${typed}${HOLDER}\r\n--XyZ--\r\n`, multipart)).toBeNull()
    expect(swap(body, multipart, 'a\r\n--XyZ\r\nforged')).toBeNull()
    expect(swap(body, { ...multipart, contentType: 'multipart/form-data' })).toBeNull()
  })

  it('leaves every other byte as it came', () => {
    const accented = `{"n":"${String.fromCodePoint(0xe9)}","p":"${HOLDER}"}`
    expect(swap(accented, json, 'v')).toBe(`{"n":"${String.fromCodePoint(0xe9)}","p":"v"}`)
  })
})

describe('swapBody', () => {
  const entry = (value: string | null): EgressPlaceholder => ({
    name: 'site_login',
    placeholder: HOLDER,
    hosts: ['app.login.test'],
    body: true,
    value: async () => Promise.resolve(value),
  })

  it('reads the value for the request and swaps it in', async () => {
    const out = await swapBody(Buffer.from(`{"p":"${HOLDER}"}`), json, [entry('v')])
    expect(out).toEqual(Buffer.from('{"p":"v"}'))
  })

  it('answers 502 without a value and 422 where the value cannot go, naming the connection only', async () => {
    expect(await swapBody(Buffer.from(HOLDER), text, [entry(null)])).toMatchObject({ status: 502 })
    const refused = await swapBody(Buffer.from(`--XyZ\r\nX: y\r\n\r\n${HOLDER}`), multipart, [entry('a\nb')])
    expect(refused).toMatchObject({ status: 422 })
    expect(JSON.stringify(refused)).toContain('site_login')
    expect(JSON.stringify(refused)).not.toContain('a\\nb')
  })
})
