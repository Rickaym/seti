import type { JournalEntry } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { controlLink, nodeLink, serveControl, serveNode, type ControlEnd, type NodeEnd } from './node-link.js'

const TASK = 'task-1'

function controlEnd(answer: ControlEnd['answer']['prompt.open']) {
  const journal = vi.fn<ControlEnd['journal']>(async () => Promise.resolve())
  const open = vi.fn(answer)
  const none = async () => Promise.reject(new Error('not asked'))
  const answers: ControlEnd['answer'] = {
    'prompt.open': open,
    'session.opening': none,
    'session.spec': none,
    'setup.key': none,
    'permission.ask': none,
    'review.ask': none,
    'repeat.ask': none,
    'hook.compact': none,
    'sandbox.hosts': none,
    'secret.mint': none,
    'aws.credentials': none,
    'connection.value': none,
    'access.reach': none,
    'ssh.keys': none,
    'tools.list': none,
    'tool.call': none,
    'call.decide': none,
  }
  serveNode({ journal, answer: answers })
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
    expect(open).toHaveBeenCalledWith(TASK, { next, queued: true }, expect.any(AbortSignal))
    expect(Object.keys(open.mock.calls[0]?.[1].next ?? {})).toEqual(['prompt', 'interrupted', 'client_id', 'priority'])
  })

  it('refuses an answer the protocol does not allow', async () => {
    controlEnd(async () => Promise.resolve({ promptId: 1.5, text: '' }))
    const next = { prompt: null, interrupted: false }
    await expect(nodeLink.ask(TASK, 'prompt.open', { next, queued: false })).rejects.toThrow()
  })
})

describe('control link', () => {
  it('refuses to command before a node serves it', async () => {
    await expect(controlLink.command('sessions.view', {})).rejects.toThrow(/No node/)
  })

  it('hands the node each command as the protocol states it and checks its answer', async () => {
    const end: NodeEnd = {
      'mode.set': () => ({ applied: 'next_turn' }),
      'policy.set': () => ({}),
      'proxy.model': () => ({}),
      'queued.retract': ({ promptId }) => ({ outcome: 'removed', promptId }),
      'quiet.restart': () => ({}),
      'sessions.view': () => ({
        sessions: [{ agent: TASK, open: true, running: true, heardAt: 5, retrying: null, kind: 'user', background: 0 }],
      }),
      'sessions.cut': () => ({}),
      'turn.send': ({ interrupt }) => ({ outcome: interrupt ? 'interrupted' : 'queued' }),
      'turn.stop': () => ({ stopped: true }),
      'session.open': () => ({}),
      'session.close': ({ onlyIdle }) => ({ closed: !onlyIdle }),
      'background.stop': () => ({ stopped: false }),
      'mcp.status': () => ({ servers: null }),
      'scopes.read': () => ({ memory: [], cpu: [] }),
      'scopes.agents': () => ({ agents: [TASK] }),
      'proxy.open': () => ({}),
      'proxy.close': () => ({}),
      'aws.token': () => ({ token: 'token' }),
      'ssh.open': () => ({}),
      'ssh.reload': () => ({}),
      'scopes.cap': () => ({}),
    }
    serveControl(end)
    await expect(controlLink.command('mode.set', { agent: TASK, mode: 'default' })).resolves.toEqual({
      applied: 'next_turn',
    })
    await expect(controlLink.command('queued.retract', { agent: TASK, promptId: 4 })).resolves.toEqual({
      outcome: 'removed',
      promptId: 4,
    })
    await expect(controlLink.command('queued.retract', { agent: '', promptId: 4 })).rejects.toThrow()
    const message = { prompt: 'hi', priority: 'now' as const }
    await expect(controlLink.command('turn.send', { agent: TASK, message, interrupt: true })).resolves.toEqual({
      outcome: 'interrupted',
    })
    await expect(controlLink.command('session.close', { agent: TASK, onlyIdle: true })).resolves.toEqual({
      closed: false,
    })
    await expect(controlLink.command('background.stop', { agent: TASK, task: '' })).rejects.toThrow()
    serveControl({ ...end, 'quiet.restart': () => ({ late: true }) as unknown as Record<string, never> })
    await expect(controlLink.command('quiet.restart', { agent: TASK, at: null })).resolves.toEqual({})
    serveControl({ ...end, 'mode.set': () => ({ applied: 'later' }) as unknown as { applied: 'now' } })
    await expect(controlLink.command('mode.set', { agent: TASK, mode: 'plan' })).rejects.toThrow()
  })
})
