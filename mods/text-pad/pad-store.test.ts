import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PadStore, SAVE_DELAY_MS, type PadDeps } from './pad-store.js'

function fakeDeps(server = '') {
  const remote = { text: server, failing: false }
  const local = { text: null as string | null }
  const deps: PadDeps = {
    load: vi.fn(async () => (remote.failing ? Promise.reject(new Error('offline')) : Promise.resolve(remote.text))),
    save: vi.fn(async (text: string) => {
      if (remote.failing) {
        return Promise.reject(new Error('offline'))
      }
      remote.text = text
      return Promise.resolve()
    }),
    backup: {
      read: () => local.text,
      write: (text) => {
        local.text = text
      },
    },
    errorText: (error) => (error instanceof Error ? error.message : 'failed'),
  }
  return { deps, remote, local }
}

describe('the pad store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads the server text and saves a short while after typing stops', async () => {
    const { deps, remote, local } = fakeDeps('hello')
    const store = new PadStore(deps)
    await store.refresh()
    expect(store.get()).toEqual({ text: 'hello', ready: true, failure: null })
    store.edit('hello there')
    expect(local.text).toBe('hello there')
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS - 1)
    expect(deps.save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(remote.text).toBe('hello there')
    expect(local.text).toBeNull()
  })

  it('saves at once on flush and never sends unchanged text', async () => {
    const { deps, remote } = fakeDeps('a')
    const store = new PadStore(deps)
    await store.refresh()
    await store.flush()
    expect(deps.save).not.toHaveBeenCalled()
    store.edit('ab')
    await store.flush()
    expect(remote.text).toBe('ab')
  })

  it('keeps the text and a failure until a retried save works', async () => {
    const { deps, remote, local } = fakeDeps('')
    const store = new PadStore(deps)
    await store.refresh()
    remote.failing = true
    store.edit('keep me')
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS)
    expect(store.get().failure).toBe('offline')
    expect(store.get().text).toBe('keep me')
    expect(local.text).toBe('keep me')
    remote.failing = false
    await vi.advanceTimersByTimeAsync(2_000)
    expect(remote.text).toBe('keep me')
    expect(store.get().failure).toBeNull()
    expect(local.text).toBeNull()
  })

  it('brings back text a failed save left in this browser', async () => {
    const { deps, remote, local } = fakeDeps('old')
    local.text = 'typed offline'
    const store = new PadStore(deps)
    await store.refresh()
    expect(store.get().text).toBe('typed offline')
    await vi.advanceTimersByTimeAsync(0)
    expect(remote.text).toBe('typed offline')
  })

  it('takes newer server text on refresh only while nothing waits to be saved', async () => {
    const { deps, remote } = fakeDeps('one')
    const store = new PadStore(deps)
    await store.refresh()
    remote.text = 'from the phone'
    await store.refresh()
    expect(store.get().text).toBe('from the phone')
    store.edit('typing here')
    remote.text = 'from the phone again'
    await store.refresh()
    expect(store.get().text).toBe('typing here')
  })

  it('stays read-only until the first load works, retrying it', async () => {
    const { deps, remote } = fakeDeps('saved')
    remote.failing = true
    const store = new PadStore(deps)
    await store.refresh()
    expect(store.get()).toEqual({ text: '', ready: false, failure: 'offline' })
    store.edit('x')
    await store.flush()
    expect(deps.save).not.toHaveBeenCalled()
    remote.failing = false
    await vi.advanceTimersByTimeAsync(5_000)
    expect(store.get()).toEqual({ text: 'saved', ready: true, failure: null })
  })

  it('saves what was typed while a save was on its way', async () => {
    const { deps, remote } = fakeDeps('')
    const store = new PadStore(deps)
    await store.refresh()
    store.edit('first')
    const saving = store.flush()
    store.edit('first and second')
    await saving
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS)
    expect(remote.text).toBe('first and second')
  })
})
