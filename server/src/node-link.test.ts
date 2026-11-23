import type { JournalEntry } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { nodeLink, serveNode, type ControlEnd } from './node-link.js'

const TASK = 'task-1'

function controlEnd(answer: ControlEnd['answer']['prompt.open']) {
  const journal = vi.fn<ControlEnd['journal']>(async () => Promise.resolve())
  const open = vi.fn(answer)
  serveNode({ journal, answer: { 'prompt.open': open } })
  return { journal, open }
}

describe('node link', () => {
  it('refuses to carry anything before a control plane serves it', async () => {
    await expect(nodeLink.journal(TASK, { type: 'turn.started' })).rejects.toThrow(/No control plane/)
  })

  it('hands each entry to the control plane as the protocol states it', async () => {
    const { journal } = controlEnd(async () => Promise.resolve({ promptId: 1, text: '' }))
    const payload = { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }
    await nodeLink.journal(TASK, { type: 'message', runtime: 'claude', payload })
    await nodeLink.journal(TASK, { type: 'turn.ended', status: 'idle', error: null })
    expect(journal.mock.calls).toEqual([
      [TASK, { type: 'message', runtime: 'claude', payload }],
      [TASK, { type: 'turn.ended', status: 'idle', error: null }],
    ])
  })

  it('refuses an entry the protocol does not know, before the control plane sees it', async () => {
    const { journal } = controlEnd(async () => Promise.resolve({ promptId: 1, text: '' }))
    const unknown = { type: 'turn.paused' } as unknown as JournalEntry
    await expect(nodeLink.journal(TASK, unknown)).rejects.toThrow()
    const negative = { type: 'session.state', open: true, background: -1 } as const
    await expect(nodeLink.journal(TASK, negative)).rejects.toThrow()
    expect(journal).not.toHaveBeenCalled()
  })

  it('drops fields an entry does not have', async () => {
    const { journal } = controlEnd(async () => Promise.resolve({ promptId: 1, text: '' }))
    const extra = { type: 'turn.started', secret: 'x' } as unknown as JournalEntry
    await nodeLink.journal(TASK, extra)
    expect(journal).toHaveBeenCalledWith(TASK, { type: 'turn.started' })
  })

  it('answers an ask with what the control plane answered, keeping the message as sent', async () => {
    const { open } = controlEnd(async () => Promise.resolve({ promptId: 7, text: 'Updates first\n\nhello' }))
    const next = { prompt: 'hello', interrupted: false, client_id: 'c1', priority: 'next' as const }
    const answer = await nodeLink.ask(TASK, 'prompt.open', { next, queued: true })
    expect(answer).toEqual({ promptId: 7, text: 'Updates first\n\nhello' })
    expect(open).toHaveBeenCalledWith(TASK, { next, queued: true })
    expect(Object.keys(open.mock.calls[0]?.[1].next ?? {})).toEqual(['prompt', 'interrupted', 'client_id', 'priority'])
  })

  it('refuses an answer the protocol does not allow', async () => {
    controlEnd(async () => Promise.resolve({ promptId: 1.5, text: '' }))
    const next = { prompt: null, interrupted: false }
    await expect(nodeLink.ask(TASK, 'prompt.open', { next, queued: false })).rejects.toThrow()
  })
})
