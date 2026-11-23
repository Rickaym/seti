import { askFrame, type AskFrame, type AskReply } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { AskLedger } from './node-inbox.js'
import { AskOutbox } from './node-outbox.js'

const BODY = { next: { prompt: 'hi', interrupted: false }, queued: false }

describe('node asks', () => {
  it('answers a retried ask with the stored answer and runs it once', async () => {
    const run = vi.fn(async () => Promise.resolve({ promptId: 3, text: 'hi' }))
    const ledger = new AskLedger(run)
    const sent: AskFrame[] = []
    const outbox = new AskOutbox((frame) => sent.push(askFrame.parse(frame)))
    const answer = outbox.ask('task-1', 'prompt.open', BODY)
    outbox.resume()
    expect(sent).toHaveLength(2)
    expect(sent[0]?.id).toBe(sent[1]?.id)
    const replies = await Promise.all(sent.map(async (frame) => ledger.receive(frame)))
    replies.forEach((reply) => {
      outbox.reply(reply)
    })
    await expect(answer).resolves.toEqual({ promptId: 3, text: 'hi' })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('hands the node the error an ask failed with, once', async () => {
    const run = vi.fn(async () => Promise.reject(new Error('Task not found')))
    const ledger = new AskLedger(run)
    const replies: AskReply[] = []
    const outbox = new AskOutbox((frame) => {
      if (frame.type === 'ask') {
        void ledger.receive(frame).then((reply) => replies.push(reply))
      }
    })
    const answer = outbox.ask('task-1', 'prompt.open', BODY)
    await vi.waitFor(() => {
      expect(replies).toHaveLength(1)
    })
    replies.forEach((reply) => {
      outbox.reply(reply)
    })
    await expect(answer).rejects.toThrow('Task not found')
  })

  it('aborts the answer in progress once the node stops waiting', async () => {
    const seen: { signal: AbortSignal | null } = { signal: null }
    const ledger = new AskLedger(async (_frame, signal) => {
      seen.signal = signal
      return new Promise(() => undefined)
    })
    const outbox = new AskOutbox((frame) => {
      if (frame.type === 'ask') {
        void ledger.receive(frame)
      } else {
        ledger.cancel(frame)
      }
    })
    const waiting = new AbortController()
    const answer = outbox.ask('task-1', 'prompt.open', BODY, waiting.signal)
    await vi.waitFor(() => {
      expect(seen.signal).not.toBeNull()
    })
    waiting.abort(new Error('The call was cancelled'))
    await expect(answer).rejects.toThrow('The call was cancelled')
    expect(seen.signal?.aborted).toBe(true)
  })

  it('forgets answers after a day', async () => {
    let now = 0
    const run = vi.fn(async () => Promise.resolve({ promptId: 1, text: '' }))
    const ledger = new AskLedger(run, () => now)
    const frame: AskFrame = { type: 'ask', id: crypto.randomUUID(), agent: 'task-1', ask: 'prompt.open', body: BODY }
    await ledger.receive(frame)
    now = 25 * 60 * 60 * 1000
    await ledger.receive(frame)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('keeps no answer that carries a value once it is sent, so a retry asks again', async () => {
    const run = vi.fn(async (_frame: AskFrame) => Promise.resolve({ token: 'minted' }))
    const ledger = new AskLedger(run)
    const valueFrame = askFrame.parse({
      type: 'ask',
      id: crypto.randomUUID(),
      agent: 'task-1',
      ask: 'secret.mint',
      body: { kind: 'connector' },
    })
    const plainFrame = askFrame.parse({
      type: 'ask',
      id: crypto.randomUUID(),
      agent: 'task-1',
      ask: 'prompt.open',
      body: BODY,
    })
    for (const frame of [valueFrame, plainFrame, valueFrame, plainFrame]) {
      await ledger.receive(frame)
    }
    expect(run.mock.calls.map(([frame]) => frame.ask)).toEqual(['secret.mint', 'prompt.open', 'secret.mint'])
  })
})
