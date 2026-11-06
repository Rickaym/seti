import type { MessageRow } from '@seti/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DraftAttachment } from '@/lib/attachments'
import {
  confirmedIds,
  createPendingStore,
  pendingReducer,
  pendingStorage,
  STALE_MS,
  type NewSend,
  type PendingSend,
  type PostSend,
} from '@/lib/pending-sends'

class MemoryStorage {
  readonly items = new Map<string, string>()
  getItem(key: string): string | null {
    return this.items.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value)
  }
  removeItem(key: string): void {
    this.items.delete(key)
  }
}

let storage: MemoryStorage

beforeEach(() => {
  storage = new MemoryStorage()
  vi.stubGlobal('localStorage', storage)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const pending = (clientId: string, state: PendingSend['state'] = 'sending'): PendingSend => ({
  clientId,
  text: `text ${clientId}`,
  prompt: `text ${clientId}`,
  attachments: [],
  files: [],
  interrupt: false,
  state,
  error: null,
  at: 1000,
})

const prompt = (id: number, clientId?: string): MessageRow => ({
  id,
  task_id: 't',
  outward: [],
  created_at: '2026-10-27T00:00:00.000Z',
  kind: 'prompt',
  payload: { text: 'hi', ...(clientId === undefined ? {} : { client_id: clientId }) },
})

const ids = (sends: readonly PendingSend[]) => sends.map((send) => `${send.clientId}:${send.state}`)

describe('pendingReducer', () => {
  it('adds sends in order and ignores a repeated id', () => {
    let sends = pendingReducer([], { type: 'add', send: pending('a') })
    sends = pendingReducer(sends, { type: 'add', send: pending('b') })
    const again = pendingReducer(sends, { type: 'add', send: pending('a', 'failed') })
    expect(again).toBe(sends)
    expect(ids(sends)).toEqual(['a:sending', 'b:sending'])
  })

  it('drops exactly the sends whose rows arrived', () => {
    const sends = [pending('a', 'sent'), pending('b'), pending('c', 'failed')]
    const left = pendingReducer(sends, { type: 'confirmed', clientIds: confirmedIds([prompt(1, 'a'), prompt(2, 'c')]) })
    expect(ids(left)).toEqual(['b:sending'])
    expect(pendingReducer(left, { type: 'confirmed', clientIds: new Set(['x']) })).toBe(left)
  })

  it('moves a send through retrying to sent, and a failure back to sending on retry', () => {
    let sends: readonly PendingSend[] = [pending('a')]
    sends = pendingReducer(sends, { type: 'retrying', clientId: 'a' })
    expect(ids(sends)).toEqual(['a:retrying'])
    sends = pendingReducer(sends, { type: 'failed', clientId: 'a', error: 'offline' })
    expect(sends[0]?.error).toBe('offline')
    sends = pendingReducer(sends, { type: 'retry', clientId: 'a' })
    expect(sends[0]).toMatchObject({ state: 'sending', error: null })
    sends = pendingReducer(sends, { type: 'sent', clientId: 'a' })
    expect(ids(sends)).toEqual(['a:sent'])
  })

  it('ignores moves a send cannot make', () => {
    const sends = [pending('a', 'sent'), pending('b', 'failed')]
    expect(pendingReducer(sends, { type: 'failed', clientId: 'a', error: 'late' })).toBe(sends)
    expect(pendingReducer(sends, { type: 'sent', clientId: 'b' })).toBe(sends)
    expect(pendingReducer(sends, { type: 'retry', clientId: 'a' })).toBe(sends)
    expect(pendingReducer(sends, { type: 'sent', clientId: 'gone' })).toBe(sends)
  })
})

describe('confirmedIds', () => {
  it('reads client ids from prompt rows only', () => {
    const sdk: MessageRow = {
      id: 3,
      task_id: 't',
      outward: [],
      created_at: '2026-10-27T00:00:00.000Z',
      kind: 'seti',
      payload: { error: 'client_id' },
    }
    expect([...confirmedIds([prompt(1), prompt(2, 'a'), sdk])]).toEqual(['a'])
  })
})

describe('pendingStorage', () => {
  it('keeps unsent and failed sends per task and drops sent ones', () => {
    pendingStorage.write('t', [pending('a'), pending('b', 'sent'), pending('c', 'failed')])
    expect(ids(pendingStorage.read('t', 2000))).toEqual(['a:sending', 'c:failed'])
    expect(pendingStorage.read('other')).toEqual([])
    pendingStorage.write('t', [pending('b', 'sent')])
    expect(storage.items.size).toBe(0)
  })

  it('resumes a retrying send and fails one too old to resend safely', () => {
    pendingStorage.write('t', [pending('a', 'retrying'), { ...pending('b'), at: 0 }])
    const [resumed, stale] = pendingStorage.read('t', STALE_MS + 1)
    expect(resumed).toMatchObject({ state: 'sending' })
    expect(stale).toMatchObject({ state: 'failed' })
  })

  it('reads nothing from broken or foreign data, and survives storage that throws', () => {
    storage.setItem('seti.pending-sends.t', '{not json')
    expect(pendingStorage.read('t')).toEqual([])
    storage.setItem('seti.pending-sends.t', JSON.stringify([{ clientId: 1 }, pending('a')]))
    expect(ids(pendingStorage.read('t', 2000))).toEqual(['a:sending'])
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('full')
      },
    })
    expect(pendingStorage.read('t')).toEqual([])
    expect(() => {
      pendingStorage.write('t', [pending('a')])
    }).not.toThrow()
  })
})

/** A post that waits until the test settles each send, recording the order they went out. */
function heldPost() {
  const started: string[] = []
  const settle = new Map<string, (error: string | null) => void>()
  const post: PostSend = async (send, onRetrying) =>
    new Promise((resolve) => {
      started.push(send.clientId)
      settle.set(send.clientId, resolve)
      if (send.prompt === 'flaky') {
        onRetrying()
      }
    })
  const finish = async (clientId: string, error: string | null = null) => {
    settle.get(clientId)?.(error)
    await vi.waitFor(() => undefined)
    await Promise.resolve()
  }
  return { post, started, finish }
}

const draft = (text: string, files: DraftAttachment[] = []): NewSend => ({
  text,
  prompt: text,
  attachments: [],
  files,
  interrupt: false,
})

function counter() {
  let n = 0
  return () => {
    n += 1
    return `id-${String(n)}`
  }
}

describe('createPendingStore', () => {
  it('sends one at a time in the order written', async () => {
    const held = heldPost()
    const store = createPendingStore('t', { post: held.post, newId: counter() })
    store.subscribe(() => undefined)
    store.add(draft('first'))
    store.add(draft('second'))
    await vi.waitFor(() => {
      expect(held.started).toEqual(['id-1'])
    })
    expect(store.snapshot().added).toBe(2)
    await held.finish('id-1')
    await vi.waitFor(() => {
      expect(held.started).toEqual(['id-1', 'id-2'])
    })
    expect(ids(store.snapshot().sends)).toEqual(['id-1:sent', 'id-2:sending'])
    store.confirm(new Set(['id-1']))
    expect(ids(store.snapshot().sends)).toEqual(['id-2:sending'])
  })

  it('marks a send that gave up as failed, retries it with the same id and edits it out', async () => {
    const held = heldPost()
    const store = createPendingStore('t', { post: held.post, newId: counter() })
    const edited: string[] = []
    store.onEdit((send) => edited.push(send.text))
    store.subscribe(() => undefined)
    store.add(draft('flaky'))
    await vi.waitFor(() => {
      expect(ids(store.snapshot().sends)).toEqual(['id-1:retrying'])
    })
    await held.finish('id-1', 'Seti did not answer in time')
    expect(store.snapshot().sends[0]).toMatchObject({ state: 'failed', error: 'Seti did not answer in time' })
    expect(ids(pendingStorage.read('t', Date.now()))).toEqual(['id-1:failed'])

    store.retry('id-1')
    await vi.waitFor(() => {
      expect(held.started).toEqual(['id-1', 'id-1'])
    })
    await held.finish('id-1', 'offline')
    store.edit('id-1')
    expect(edited).toEqual(['flaky'])
    expect(store.snapshot().sends).toEqual([])
    expect(storage.items.size).toBe(0)
  })

  it('edits only failed sends', () => {
    const held = heldPost()
    const store = createPendingStore('t', { post: held.post, newId: counter() })
    const edited: string[] = []
    store.onEdit((send) => edited.push(send.text))
    store.add(draft('still going'))
    store.edit('id-1')
    expect(edited).toEqual([])
    expect(ids(store.snapshot().sends)).toEqual(['id-1:sending'])
  })

  it('discards only failed sends, without handing them to the reply box', async () => {
    const held = heldPost()
    const store = createPendingStore('t', { post: held.post, newId: counter() })
    const edited: string[] = []
    store.onEdit((send) => edited.push(send.text))
    store.subscribe(() => undefined)
    store.add(draft('unwanted'))
    store.discard('id-1')
    await vi.waitFor(() => {
      expect(held.started).toEqual(['id-1'])
    })
    await held.finish('id-1', 'offline')
    expect(ids(store.snapshot().sends)).toEqual(['id-1:failed'])
    store.discard('id-1')
    expect(store.snapshot().sends).toEqual([])
    expect(edited).toEqual([])
    expect(storage.items.size).toBe(0)
  })

  it('resumes saved sends in order on first subscribe and skips failed ones', async () => {
    pendingStorage.write('t', [pending('a'), pending('b', 'failed'), pending('c')])
    const held = heldPost()
    const store = createPendingStore('t', { post: held.post, now: () => 2000 })
    expect(held.started).toEqual([])
    store.subscribe(() => undefined)
    await vi.waitFor(() => {
      expect(held.started).toEqual(['a'])
    })
    await held.finish('a')
    await vi.waitFor(() => {
      expect(held.started).toEqual(['a', 'c'])
    })
    expect(store.snapshot().added).toBe(0)
  })

  it('skips a send the transcript confirmed before its turn came', async () => {
    const held = heldPost()
    const store = createPendingStore('t', { post: held.post, newId: counter() })
    store.subscribe(() => undefined)
    store.add(draft('one'))
    store.add(draft('two'))
    store.confirm(new Set(['id-2']))
    await vi.waitFor(() => {
      expect(held.started).toEqual(['id-1'])
    })
    await held.finish('id-1')
    await vi.waitFor(() => {
      expect(ids(store.snapshot().sends)).toEqual(['id-1:sent'])
    })
    expect(held.started).toEqual(['id-1'])
  })

  it('keeps files without their preview or pasted text', () => {
    const file: DraftAttachment = {
      key: 'k',
      token: '[a.txt]',
      name: 'a.txt',
      kind: 'text',
      type: 'Text',
      size: 3,
      lines: 1,
      staged: null,
      text: 'abc',
      preview: 'blob:x',
    }
    const store = createPendingStore('t', { post: heldPost().post, newId: counter() })
    store.add(draft('see [a.txt]', [file]))
    expect(store.snapshot().sends[0]?.files).toEqual([
      { key: 'k', token: '[a.txt]', name: 'a.txt', kind: 'text', type: 'Text', size: 3, lines: 1, staged: null },
    ])
  })
})
