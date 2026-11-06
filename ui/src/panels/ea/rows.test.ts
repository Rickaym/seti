import type { EaChatEvent, EaHistoryEntry, EaLlmMessage, MessageRow } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { applyEvent, chatView, lastReply, liveRows, SUMMARISED, type LiveExchange } from './rows'
import { parseEvent, readEvents } from './stream'

const AT = '2026-09-28T09:00:00.000Z'

const entry = (
  id: number,
  message: EaLlmMessage,
  kind: EaHistoryEntry['kind'] = 'message',
  through: number | null = null,
): EaHistoryEntry => ({ id, kind, message, through_id: through, created_at: AT })

const CONVERSATION: EaHistoryEntry[] = [
  entry(1, { role: 'developer', content: 'A new call started.' }, 'call'),
  entry(2, { role: 'user', content: 'Anything on fire?' }),
  entry(3, { role: 'assistant', content: 'Nothing on fire.' }),
  entry(4, { role: 'developer', content: 'The user is typing in the Seti chat now.' }, 'chat'),
  entry(5, { role: 'user', content: 'What is running?' }, 'chat'),
  entry(
    6,
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_tasks', arguments: '{"status":"running"}' } }],
    },
    'chat',
  ),
  entry(7, { role: 'tool', tool_call_id: 'c1', content: '"1 task: 1 running."' }, 'chat'),
  entry(8, { role: 'assistant', content: '- **login**: running' }, 'chat'),
]

function describeRow(row: MessageRow): string {
  if (row.kind === 'prompt') {
    return `prompt ${row.payload.text}`
  }
  if (row.kind !== 'sdk') {
    return row.kind
  }
  const { payload } = row
  if (payload.type === 'assistant') {
    return payload.message.content
      .map((block) => {
        if (block.type === 'text') {
          return `text ${block.text}`
        }
        return block.type === 'tool_use' ? `tool ${block.name}` : ''
      })
      .join(', ')
  }
  if (payload.type === 'user' && typeof payload.message.content !== 'string') {
    return payload.message.content
      .map((block) =>
        block.type === 'tool_result' && typeof block.content === 'string' ? `result ${block.content}` : '',
      )
      .join(', ')
  }
  return payload.type
}

describe('chatView', () => {
  it('shows spoken and typed turns as task transcript rows, marking the spoken ones', () => {
    const view = chatView(CONVERSATION)
    expect(view.rows.map(describeRow)).toEqual([
      'prompt Anything on fire?',
      'text Nothing on fire.',
      'prompt What is running?',
      'tool list_tasks',
      'result 1 task: 1 running.',
      'text - **login**: running',
    ])
    expect(view.rows.map((row) => row.id)).toEqual([2, 3, 5, 6, 7, 8])
    expect([...view.marks.voice]).toEqual([2, 3])
    expect(view.marks.notes.get(2)?.text).toMatch(/^Call started /)
    const call = view.rows[3]
    expect(call?.kind === 'sdk' && call.payload.type === 'assistant' && call.payload.message.content[0]).toMatchObject({
      type: 'tool_use',
      id: 'c1',
      input: { status: 'running' },
    })
  })

  it('puts a summary before the first turn it did not cover', () => {
    const entries = [
      ...CONVERSATION.slice(0, 3),
      entry(
        9,
        { role: 'user', content: 'Summary of the earlier conversation with the user: They asked.' },
        'summary',
        3,
      ),
      entry(10, { role: 'user', content: 'Next?' }, 'chat'),
    ]
    const view = chatView(entries)
    expect(view.rows.map((row) => row.id)).toEqual([2, 3, 10])
    expect(view.marks.notes.get(10)).toEqual({ text: SUMMARISED, detail: 'They asked.' })
  })

  it('follows the stored rows with the reply in flight until the history has it', () => {
    let live: LiveExchange = { text: 'Plan my day', at: AT, parts: [] }
    const events: EaChatEvent[] = [
      { type: 'text', delta: 'Checking ' },
      { type: 'text', delta: 'now.' },
      { type: 'tool', id: 'c2', name: 'seti_overview', arguments: {} },
      { type: 'tool_result', id: 'c2', name: 'seti_overview', summary: 'Overview', ok: false, text: 'Seti is down.' },
      { type: 'text', delta: 'Seti is down.' },
    ]
    for (const event of events) {
      live = applyEvent(live, event)
    }
    const rows = liveRows(CONVERSATION, live)
    expect(rows.map(describeRow)).toEqual([
      'prompt Plan my day',
      'text Checking now.',
      'tool seti_overview',
      'result Seti is down.',
      'text Seti is down.',
    ])
    const result = rows[3]
    expect(result?.kind === 'sdk' && result.payload.type === 'user' && result.payload.message.content).toEqual([
      { type: 'tool_result', tool_use_id: 'c2', content: 'Seti is down.', is_error: true },
    ])
    const stored = new Set(chatView(CONVERSATION).rows.map((row) => row.id))
    expect(rows.some((row) => stored.has(row.id))).toBe(false)

    const done = applyEvent(live, { type: 'done', ids: [11, 12] })
    expect(liveRows(CONVERSATION, done)).toHaveLength(5)
    const landed = [
      ...CONVERSATION,
      entry(11, { role: 'user', content: 'Plan my day' }, 'chat'),
      entry(12, { role: 'assistant', content: 'Down.' }, 'chat'),
    ]
    expect(liveRows(landed, done)).toEqual([])
    expect(liveRows(CONVERSATION, null)).toEqual([])
  })

  it('shows inbox entries as notices, falling back to their text without one', () => {
    const notice = {
      kind: 'watch_event' as const,
      event: 'turn_finished',
      title: 'Voicemail finished its turn',
      body: 'done',
      url: null,
      severity: 'success' as const,
      source: 'Voicemail',
    }
    const view = chatView([
      { ...entry(1, { role: 'developer', content: 'Inbox: from the watched task.' }, 'inbox'), notice },
      entry(2, { role: 'developer', content: 'Inbox: a reminder the user asked for: stretch.' }, 'inbox'),
      entry(3, { role: 'assistant', content: 'The voicemail task has finished.' }, 'chat'),
    ])
    const [first, second] = view.rows
    expect(first).toMatchObject({ kind: 'notice', payload: notice })
    expect(second).toMatchObject({
      kind: 'notice',
      payload: { title: 'a reminder the user asked for: stretch.', severity: 'info' },
    })
    expect(view.rows).toHaveLength(3)
    expect(
      lastReply([
        entry(3, { role: 'assistant', content: 'Done.' }, 'chat'),
        entry(4, { role: 'developer', content: 'Inbox: x' }, 'inbox'),
      ]),
    ).toBe('Done.')
  })

  it('offers a yes only when the EA asked last', () => {
    expect(lastReply(CONVERSATION)).toBe('- **login**: running')
    expect(lastReply([...CONVERSATION, entry(9, { role: 'user', content: 'ok' }, 'chat')])).toBeNull()
    expect(lastReply([])).toBeNull()
  })
})

describe('reply stream', () => {
  it('parses server-sent events and skips pings and unknown ones', () => {
    expect(parseEvent('event: text\ndata: {"delta": "Hi"}')).toEqual({ type: 'text', delta: 'Hi' })
    expect(parseEvent(': ping')).toBeNull()
    expect(parseEvent('event: mystery\ndata: {}')).toBeNull()
    expect(parseEvent('event: done\ndata: not json')).toBeNull()
  })

  it('yields each event as its block completes, across chunk boundaries', async () => {
    const encoder = new TextEncoder()
    const chunks = [
      'event: text\r\ndata: {"delta": "Two',
      ' tasks"}\r\n\r\n: ping\n\nevent: done\n',
      'data: {"ids": [4]}\n\n',
    ]
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      },
    })
    const seen: EaChatEvent[] = []
    for await (const event of readEvents(body)) {
      seen.push(event)
    }
    expect(seen).toEqual([
      { type: 'text', delta: 'Two tasks' },
      { type: 'done', ids: [4] },
    ])
  })
})
