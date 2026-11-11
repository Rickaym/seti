import type {
  Aside,
  ModCommandHandler,
  ModRouteHandler,
  ModStreamHandler,
  ServerModApi,
  SideChatEvent,
} from '@seti/mod-api'
import { describe, expect, it, vi } from 'vitest'
import { sideChatServer } from './server.js'

const ASIDE: Aside = {
  id: '00000000-0000-4000-8000-0000000000a1',
  task_id: 't1',
  chat_id: 'c1',
  question: 'why?',
  answer: 'Because it was faster',
  asked_by: 'ea',
  asker_id: null,
  asker_title: null,
  cost_usd: 0.02,
  asked_at: '2026-11-11T10:00:00.000Z',
  answered_at: '2026-11-11T10:00:05.000Z',
}

const EVENTS: SideChatEvent[] = [
  { type: 'start', chat_id: 'c1' },
  { type: 'text', text: 'Because' },
  { type: 'done', text: 'Because it was faster', cost_usd: 0.02, aside: ASIDE },
]

/** The side chat's server half on a fake mod API whose engine answers every question at once. */
function startSideChat() {
  const routes = new Map<string, ModRouteHandler>()
  const streams = new Map<string, ModStreamHandler>()
  const commands = new Map<string, ModCommandHandler>()
  const aside = {
    ask: vi.fn(async (_task: string, _input: unknown, emit: (event: SideChatEvent) => Promise<void>) => {
      for (const event of EVENTS) {
        await emit(event)
      }
    }),
    answer: vi.fn(async (id: string, question: string) =>
      Promise.resolve({ id, title: 'Docs agent', answer: `Because of ${question}`, cost_usd: 0.02 }),
    ),
    list: vi.fn(async () => Promise.resolve([ASIDE])),
    remove: vi.fn(async () => Promise.resolve()),
    clear: vi.fn(async () => Promise.resolve(3)),
  }
  const transcript = { refresh: vi.fn(async () => Promise.resolve()) }
  const api = {
    aside,
    transcript,
    route: (method: string, path: string, handler: ModRouteHandler) => {
      routes.set(`${method} ${path}`, handler)
      return () => undefined
    },
    streamRoute: (method: string, path: string, handler: ModStreamHandler) => {
      streams.set(`${method} ${path}`, handler)
      return () => undefined
    },
    registerCommand: (id: string, handler: ModCommandHandler) => {
      commands.set(id, handler)
      return () => undefined
    },
  } as unknown as ServerModApi
  sideChatServer.server(api)
  return { routes, streams, commands, aside, transcript }
}

const request = (params: Record<string, string>, body: unknown = null) => ({
  params,
  query: {},
  body,
  caller: { source: 'user' as const, agent: null },
})

const ea = { source: 'ea', agent: null } as const

describe('the side chat server half', () => {
  it('streams each answer event under its type, then refreshes the transcript', async () => {
    const { streams, aside, transcript } = startSideChat()
    const sent: [string, unknown][] = []
    const signal = new AbortController().signal
    const body = { question: 'why?', chat_id: 'c1' }
    await streams.get('POST /tasks/:task')?.(request({ task: 't1' }, body), {
      send: async (event, data) => {
        sent.push([event, data])
        return Promise.resolve()
      },
      signal,
    })
    expect(aside.ask).toHaveBeenCalledWith('t1', body, expect.any(Function), signal)
    expect(sent).toEqual(EVENTS.map((event) => [event.type, event]))
    expect(transcript.refresh).toHaveBeenCalledWith('t1')
  })

  it('lists, deletes one and clears every aside of an agent', async () => {
    const { routes, aside, transcript } = startSideChat()
    expect(await routes.get('GET /tasks/:task/asides')?.(request({ task: 't1' }))).toEqual({
      body: { asides: [ASIDE] },
    })
    const one = await routes.get('DELETE /tasks/:task/asides/:aside')?.(request({ task: 't1', aside: ASIDE.id }))
    expect(one).toEqual({ body: null })
    expect(aside.remove).toHaveBeenCalledWith('t1', ASIDE.id)
    expect(await routes.get('DELETE /tasks/:task/asides')?.(request({ task: 't1' }))).toEqual({
      body: { cleared: 3 },
    })
    expect(transcript.refresh).toHaveBeenCalledTimes(2)
  })

  it('answers the EA and agents whole, with the line they read', async () => {
    const { commands, aside, transcript } = startSideChat()
    const result = await commands.get('ask')?.({ args: { task: 't1', question: 'the retry' }, caller: ea })
    expect(aside.answer).toHaveBeenCalledWith('t1', 'the retry')
    expect(result).toMatchObject({ id: 't1', text: 'Docs agent answers aside: Because of the retry' })
    expect(transcript.refresh).toHaveBeenCalledWith('t1')
  })

  it('lists asides for the EA and clears one or all', async () => {
    const { commands, aside } = startSideChat()
    const listed = await commands.get('asides')?.({ args: { task: 't1' }, caller: ea })
    expect(listed).toContain(`${ASIDE.id}, asked by the EA`)
    expect(listed).toContain('A: Because it was faster')
    expect(await commands.get('clear')?.({ args: { task: 't1', aside: ASIDE.id }, caller: ea })).toBe(
      'Deleted the aside.',
    )
    expect(aside.remove).toHaveBeenCalledWith('t1', ASIDE.id)
    expect(await commands.get('clear')?.({ args: { task: 't1' }, caller: ea })).toBe('Deleted 3 asides.')
  })
})
