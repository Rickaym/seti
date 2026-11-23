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
      void ledger.receive(frame).then((reply) => replies.push(reply))
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
})
