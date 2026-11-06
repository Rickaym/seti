import type { ModCommandHandler, ModRouteHandler, ModStreamHandler, ServerModApi, SideChatEvent } from '@seti/mod-api'
import { describe, expect, it, vi } from 'vitest'
import { sideChatServer } from './server.js'

const EVENTS: SideChatEvent[] = [
  { type: 'start', chat_id: 'c1', turns_left: 7 },
  { type: 'text', text: 'Because' },
  { type: 'done', text: 'Because it was faster', cost_usd: 0.02, turns_left: 7 },
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
    close: vi.fn(async () => Promise.resolve()),
  }
  const api = {
    aside,
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
  return { routes, streams, commands, aside }
}

const request = (params: Record<string, string>, body: unknown = null) => ({
  params,
  query: {},
  body,
  caller: { source: 'user' as const, agent: null },
})

describe('the side chat server half', () => {
  it('streams each answer event under its type, with the body and task the dock sent', async () => {
    const { streams, aside } = startSideChat()
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
  })

  it('closes a chat by its task and id', async () => {
    const { routes, aside } = startSideChat()
    const answer = await routes.get('DELETE /tasks/:task/chats/:chat')?.(request({ task: 't1', chat: 'c1' }))
    expect(answer).toEqual({ body: null })
    expect(aside.close).toHaveBeenCalledWith('t1', 'c1')
  })

  it('answers the EA and agents whole, with the line they read', async () => {
    const { commands, aside } = startSideChat()
    const caller = { source: 'ea', agent: null } as const
    const result = await commands.get('ask')?.({ args: { task: 't1', question: 'the retry' }, caller })
    expect(aside.answer).toHaveBeenCalledWith('t1', 'the retry')
    expect(result).toMatchObject({ id: 't1', text: 'Docs agent answers aside: Because of the retry' })
  })
})
