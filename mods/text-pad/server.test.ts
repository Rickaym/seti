import type { ModCommandHandler, ModRouteHandler, ServerModApi } from '@seti/mod-api'
import { describe, expect, it, vi } from 'vitest'
import { PAD_MAX } from './pad-text.js'
import { textPadServer } from './server.js'

/** The pad's server half on a fake mod API with an in-memory store. */
function startPad(initial?: string) {
  const routes = new Map<string, ModRouteHandler>()
  const commands = new Map<string, ModCommandHandler>()
  const store = new Map<string, unknown>(initial === undefined ? [] : [['text', initial]])
  const audit = vi.fn(async () => Promise.resolve())
  const api = {
    storage: {
      get: async (key: string) => Promise.resolve(store.get(key)),
      set: async (key: string, value: unknown) => {
        store.set(key, value)
        return Promise.resolve()
      },
    },
    audit,
    route: (method: string, path: string, handler: ModRouteHandler) => {
      routes.set(`${method} ${path}`, handler)
      return () => undefined
    },
    registerCommand: (id: string, handler: ModCommandHandler) => {
      commands.set(id, handler)
      return () => undefined
    },
  } as unknown as ServerModApi
  textPadServer.server(api)
  const route = (key: string) => {
    const handler = routes.get(key)
    if (handler === undefined) {
      throw new Error(`No route ${key}`)
    }
    return handler
  }
  const command = (id: string) => {
    const handler = commands.get(id)
    if (handler === undefined) {
      throw new Error(`No command ${id}`)
    }
    return handler
  }
  return { route, command, store, audit }
}

const user = { source: 'user', agent: null } as const
const ea = { source: 'ea', agent: null } as const
const agent = { source: 'agent', agent: 't1' } as const

const request = (caller: typeof user | typeof ea | typeof agent, body: unknown = null) => ({
  params: {},
  query: {},
  body,
  caller,
})

describe('the pad server half', () => {
  it('answers an empty pad, then the text the user saved', async () => {
    const pad = startPad()
    expect(await pad.route('GET /text')(request(user))).toEqual({ body: { text: '' } })
    expect(await pad.route('PUT /text')(request(user, { text: 'milk\neggs' }))).toEqual({
      body: { text: 'milk\neggs' },
    })
    expect(await pad.route('GET /text')(request(user))).toEqual({ body: { text: 'milk\neggs' } })
  })

  it('refuses text past the limit with a reason, and keeps what it had', async () => {
    const pad = startPad('kept')
    const answer = await pad.route('PUT /text')(request(user, { text: 'x'.repeat(PAD_MAX + 1) }))
    expect(answer).toEqual({ status: 422, body: 'The pad holds at most 20,000 characters' })
    expect(pad.store.get('text')).toBe('kept')
    const fits = await pad.route('PUT /text')(request(user, { text: 'x'.repeat(PAD_MAX) }))
    expect(fits.status).toBeUndefined()
  })

  it('refuses a body without text', async () => {
    const pad = startPad()
    expect((await pad.route('PUT /text')(request(user, { words: 'no' }))).status).toBe(400)
  })

  it('lets only the user replace the pad, and keeps agents out of it', async () => {
    const pad = startPad('mine')
    expect((await pad.route('PUT /text')(request(ea, { text: 'gone' }))).status).toBe(403)
    expect((await pad.route('PUT /text')(request(agent, { text: 'gone' }))).status).toBe(403)
    expect((await pad.route('GET /text')(request(agent))).status).toBe(403)
    expect(pad.store.get('text')).toBe('mine')
  })

  it('reads the pad to the EA and adds a line on its own line, audited', async () => {
    const pad = startPad('milk')
    const call = { args: { line: '  call the bank ' }, caller: ea }
    expect(await pad.command('append')(call)).toEqual({ text: 'Added the line to the pad.' })
    expect(pad.store.get('text')).toBe('milk\ncall the bank')
    expect(pad.audit).toHaveBeenCalledWith('appended', 'Added a line to the pad', { characters: 13 })
    expect(await pad.command('read')({ args: {}, caller: ea })).toEqual({
      text: "The user's pad holds:\nmilk\ncall the bank",
    })
  })

  it('says an empty pad is empty, and refuses a line that does not fit', async () => {
    const pad = startPad()
    expect(await pad.command('read')({ args: {}, caller: ea })).toEqual({ text: 'The pad is empty.' })
    await pad.route('PUT /text')(request(user, { text: 'x'.repeat(PAD_MAX - 2) }))
    await expect(pad.command('append')({ args: { line: 'abc' }, caller: ea })).rejects.toThrow(
      'The pad holds at most 20,000 characters, so the line does not fit',
    )
    await expect(pad.command('append')({ args: { line: '   ' }, caller: ea })).rejects.toThrow('Give the line')
  })
})
