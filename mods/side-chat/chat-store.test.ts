import type { UiModApi } from '@seti/mod-api'
import { describe, expect, it, vi } from 'vitest'
import { sideChats } from './chat-store.js'

type Stream = UiModApi['stream']

/** A fake mod API whose stream answers with the events a test hands it, then ends or hangs. */
function fakeApi(answer: (onEvent: (data: unknown) => void, signal: AbortSignal) => Promise<void>) {
  const request = vi.fn(async () => Promise.resolve(null))
  const stream = vi.fn<Stream>(async (_path, _body, onEvent, signal) => answer(onEvent, signal))
  const api = { request, stream, kit: { errorText: (e: unknown) => String(e) } }
  return { api: api as unknown as Pick<UiModApi, 'request' | 'stream' | 'kit'>, request, stream }
}

const answered =
  (text: string, left = 7) =>
  async (onEvent: (data: unknown) => void) => {
    onEvent({ type: 'start', chat_id: '00000000-0000-4000-8000-000000000001', turns_left: left })
    onEvent({ type: 'text', text })
    onEvent({ type: 'done', text, cost_usd: null, turns_left: left })
    return Promise.resolve()
  }

const hung = async (_onEvent: (data: unknown) => void, signal: AbortSignal) =>
  new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(new Error('aborted'))
    })
  })

describe('the side chats store', () => {
  it('streams an answer into its exchange and follows up in the same chat', async () => {
    const { api, stream } = fakeApi(answered('Because'))
    const chats = sideChats(api)
    chats.ask('t1', 'why?')
    await vi.waitFor(() => {
      expect(chats.view('t1').exchanges[0]).toMatchObject({ question: 'why?', answer: 'Because', state: 'done' })
    })
    expect(chats.view('t1')).toMatchObject({ answering: false, turnsLeft: 7 })
    chats.ask('t1', 'and then?')
    await vi.waitFor(() => {
      expect(chats.view('t1').exchanges).toHaveLength(2)
    })
    expect(stream.mock.calls[0]?.slice(0, 2)).toEqual(['/tasks/t1', { question: 'why?' }])
    expect(stream.mock.calls[1]?.[1]).toEqual({
      question: 'and then?',
      chat_id: '00000000-0000-4000-8000-000000000001',
    })
  })

  it('says it is answering while a stream runs, and a reset stops it and ends the chat', () => {
    const { api, request } = fakeApi(async (onEvent, signal) => {
      onEvent({ type: 'start', chat_id: '00000000-0000-4000-8000-000000000002', turns_left: 7 })
      return hung(onEvent, signal)
    })
    const chats = sideChats(api)
    const seen = vi.fn()
    chats.subscribe(seen)
    chats.ask('t1', 'slow?')
    expect(chats.view('t1').answering).toBe(true)
    chats.reset('t1')
    expect(chats.view('t1')).toMatchObject({ exchanges: [], answering: false })
    expect(request).toHaveBeenCalledWith('DELETE', '/tasks/t1/chats/00000000-0000-4000-8000-000000000002')
    expect(seen).toHaveBeenCalled()
  })

  it('starts a new chat once this one took its questions', async () => {
    const { api, stream } = fakeApi(answered('Done', 0))
    const chats = sideChats(api)
    chats.ask('t1', 'last one')
    await vi.waitFor(() => {
      expect(chats.view('t1')).toMatchObject({ turnsLeft: 0, answering: false })
    })
    chats.ask('t1', 'fresh')
    expect(chats.view('t1').exchanges.map((e) => e.question)).toEqual(['fresh'])
    expect(stream.mock.calls[1]?.[1]).toEqual({ question: 'fresh' })
  })

  it('marks an answer that ended without one as failed', async () => {
    const { api } = fakeApi(async () => Promise.resolve())
    const chats = sideChats(api)
    chats.ask('t1', 'anyone?')
    await vi.waitFor(() => {
      expect(chats.view('t1').exchanges[0]).toMatchObject({
        state: 'failed',
        error: 'The side chat ended without an answer',
      })
    })
  })

  it('forgets every chat without asking the server, as turning the mod off does', () => {
    const { api, request } = fakeApi(async (onEvent, signal) => {
      onEvent({ type: 'start', chat_id: '00000000-0000-4000-8000-000000000003', turns_left: 7 })
      return hung(onEvent, signal)
    })
    const chats = sideChats(api)
    chats.ask('t1', 'slow?')
    chats.forgetAll()
    expect(chats.view('t1')).toMatchObject({ exchanges: [], answering: false })
    expect(request).not.toHaveBeenCalled()
  })
})
