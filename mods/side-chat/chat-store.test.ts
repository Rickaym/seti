import type { Aside, UiModApi } from '@seti/mod-api'
import { describe, expect, it, vi } from 'vitest'
import { PENDING, sideChats } from './chat-store.js'

type Stream = UiModApi['stream']

const CHAT = '00000000-0000-4000-8000-000000000001'

const asideOf = (id: string, question: string, extra: Partial<Aside> = {}): Aside => ({
  id,
  task_id: 't1',
  chat_id: CHAT,
  question,
  answer: `Because ${question}`,
  asked_by: 'user',
  asker_id: null,
  asker_title: null,
  cost_usd: null,
  asked_at: '2026-11-11T10:00:00.000Z',
  answered_at: '2026-11-11T10:00:05.000Z',
  ...extra,
})

/** A fake mod API: its stream answers with the events a test hands it, its routes with `stored`. */
function fakeApi(
  answer: (onEvent: (data: unknown) => void, signal: AbortSignal, body: unknown) => Promise<void>,
  stored: Aside[] = [],
) {
  const request = vi.fn(async (method: string) => Promise.resolve(method === 'GET' ? { asides: stored } : null))
  const stream = vi.fn<Stream>(async (_path, body, onEvent, signal) => answer(onEvent, signal, body))
  const api = { request, stream, kit: { errorText: (e: unknown) => String(e) } }
  return { api: api as unknown as Pick<UiModApi, 'request' | 'stream' | 'kit'>, request, stream }
}

const answered = async (onEvent: (data: unknown) => void, _signal: AbortSignal, body: unknown) => {
  const { question, chat_id: chat = 'c-new' } = body as { question: string; chat_id?: string }
  onEvent({ type: 'start', chat_id: chat })
  onEvent({ type: 'text', text: 'Because' })
  onEvent({
    type: 'done',
    text: 'Because',
    cost_usd: null,
    aside: asideOf(`a-${question}`, question, { chat_id: chat }),
  })
  return Promise.resolve()
}

const hung = async (_onEvent: (data: unknown) => void, signal: AbortSignal) =>
  new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(new Error('aborted'))
    })
  })

describe('the side chats store', () => {
  it('loads stored asides while watched and places them in the transcript by when they were asked', async () => {
    const stored = [asideOf('a1', 'first', { asked_by: 'ea' })]
    const { api, request } = fakeApi(answered, stored)
    const chats = sideChats(api)
    const stop = chats.watch('t1')
    await vi.waitFor(() => {
      expect(chats.view('t1').loaded).toBe(true)
    })
    expect(request).toHaveBeenCalledWith('GET', '/tasks/t1/asides')
    expect(chats.view('t1').blocks).toEqual([{ id: 'a1', at: '2026-11-11T10:00:00.000Z' }])
    stop()
  })

  it('follows up the newest stored chat, so a reload continues it from what Seti kept', async () => {
    const { api, stream } = fakeApi(answered, [asideOf('a1', 'first')])
    const chats = sideChats(api)
    chats.watch('t1')
    await vi.waitFor(() => {
      expect(chats.view('t1').loaded).toBe(true)
    })
    chats.ask('t1', 'and then?')
    await vi.waitFor(() => {
      expect(chats.view('t1').asides.map((a) => a.question)).toEqual(['first', 'and then?'])
    })
    expect(stream.mock.calls[0]?.slice(0, 2)).toEqual(['/tasks/t1', { question: 'and then?', chat_id: CHAT }])
    expect(chats.view('t1').open.has('a-and then?')).toBe(true)
  })

  it('starts a new chat when the user asks for one', async () => {
    const { api, stream } = fakeApi(answered, [asideOf('a1', 'first')])
    const chats = sideChats(api)
    chats.watch('t1')
    await vi.waitFor(() => {
      expect(chats.view('t1').loaded).toBe(true)
    })
    chats.setStartNew('t1', true)
    chats.ask('t1', 'fresh')
    await vi.waitFor(() => {
      expect(chats.view('t1').asides).toHaveLength(2)
    })
    expect(stream.mock.calls[0]?.[1]).toEqual({ question: 'fresh' })
    expect(chats.view('t1').startNew).toBe(false)
  })

  it('shows the question being answered as a live block until its aside is stored', () => {
    const { api } = fakeApi(async (onEvent, signal) => {
      onEvent({ type: 'start', chat_id: CHAT })
      onEvent({ type: 'text', text: 'So far' })
      return hung(onEvent, signal)
    })
    const chats = sideChats(api)
    chats.ask('t1', 'slow?')
    expect(chats.view('t1')).toMatchObject({ answering: true, pending: { question: 'slow?', answer: 'So far' } })
    expect(chats.view('t1').blocks.map((block) => block.id)).toEqual([PENDING])
    chats.forgetAll()
  })

  it('marks an answer that ended without one as failed, and keeps it out of the transcript', async () => {
    const { api } = fakeApi(async () => Promise.resolve())
    const chats = sideChats(api)
    chats.ask('t1', 'anyone?')
    await vi.waitFor(() => {
      expect(chats.view('t1').pending).toMatchObject({
        state: 'failed',
        error: 'The side chat ended without an answer',
      })
    })
    expect(chats.view('t1').blocks).toEqual([])
  })

  it('deletes one aside and clears them all through the routes', async () => {
    const { api, request } = fakeApi(answered, [asideOf('a1', 'first'), asideOf('a2', 'second')])
    const chats = sideChats(api)
    chats.watch('t1')
    await vi.waitFor(() => {
      expect(chats.view('t1').asides).toHaveLength(2)
    })
    await chats.remove('t1', 'a1')
    expect(request).toHaveBeenCalledWith('DELETE', '/tasks/t1/asides/a1')
    expect(chats.view('t1').asides.map((a) => a.id)).toEqual(['a2'])
    await chats.clear('t1')
    expect(request).toHaveBeenCalledWith('DELETE', '/tasks/t1/asides')
    expect(chats.view('t1').asides).toEqual([])
  })

  it('refreshes only an agent something shows', async () => {
    const { api, request } = fakeApi(answered)
    const chats = sideChats(api)
    chats.refresh('t1')
    expect(request).not.toHaveBeenCalled()
    const stop = chats.watch('t2')
    stop()
    await vi.waitFor(() => {
      expect(chats.view('t2').loaded).toBe(true)
    })
    chats.refresh('t2')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('forgets everything without asking the server, as turning the mod off does', () => {
    const { api, request } = fakeApi(async (onEvent, signal) => {
      onEvent({ type: 'start', chat_id: CHAT })
      return hung(onEvent, signal)
    })
    const chats = sideChats(api)
    chats.ask('t1', 'slow?')
    chats.forgetAll()
    expect(chats.view('t1')).toMatchObject({ asides: [], answering: false, pending: null })
    expect(request).not.toHaveBeenCalled()
  })
})
