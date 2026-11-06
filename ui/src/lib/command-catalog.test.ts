import type { CommandCatalog, ComposerCommand } from '@seti/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandCatalogStore } from '@/lib/command-catalog'

const command = (name: string): ComposerCommand => ({
  name,
  description: `Runs ${name}`,
  argument_hint: '',
  aliases: [],
  builtin: false,
  unsupported: null,
})

const catalog = (names: string[], fresh: boolean): CommandCatalog => ({
  cwd: fresh ? '/worktree' : '/main',
  probed_at: '2026-09-30T10:00:00.000Z',
  fresh,
  approximate: !fresh,
  commands: names.map(command),
})

const PATH = '/tasks/t1/commands'
const names = (store: CommandCatalogStore) => store.get(PATH)?.commands?.map((entry) => entry.name)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('command catalog store', () => {
  it('shows a stand-in list at once, marks it updating and swaps in the exact list', async () => {
    const load = vi
      .fn<(path: string) => Promise<CommandCatalog>>()
      .mockResolvedValueOnce(catalog(['compact', 'main-only'], false))
      .mockResolvedValueOnce(catalog(['compact', 'main-only'], false))
      .mockResolvedValueOnce(catalog(['compact', 'worktree-only'], true))
    const store = new CommandCatalogStore(load, 1000)
    const changes = vi.fn()
    store.subscribe(changes)

    store.request(PATH)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.get(PATH)).toMatchObject({ loading: false, updating: true, error: null })
    expect(names(store)).toEqual(['compact', 'main-only'])

    store.request(PATH)
    expect(load).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(load).toHaveBeenCalledTimes(2)
    expect(store.get(PATH)).toMatchObject({ updating: true })
    expect(names(store)).toEqual(['compact', 'main-only'])

    await vi.advanceTimersByTimeAsync(1000)
    expect(load).toHaveBeenCalledTimes(3)
    expect(store.get(PATH)).toMatchObject({ loading: false, updating: false, error: null })
    expect(names(store)).toEqual(['compact', 'worktree-only'])

    await vi.advanceTimersByTimeAsync(10_000)
    expect(load).toHaveBeenCalledTimes(3)
    expect(changes).toHaveBeenCalled()
  })

  it('gives up asking after a while and keeps the stand-in', async () => {
    const load = vi.fn(async (_path: string) => Promise.resolve(catalog(['compact'], false)))
    const store = new CommandCatalogStore(load, 1000)
    store.request(PATH)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(load).toHaveBeenCalledTimes(31)
    expect(store.get(PATH)).toMatchObject({ updating: false, error: null })
    expect(names(store)).toEqual(['compact'])
  })

  it('keeps the stand-in when a refresh fails, and reports a first load that fails', async () => {
    const load = vi
      .fn<(path: string) => Promise<CommandCatalog>>()
      .mockResolvedValueOnce(catalog(['compact'], false))
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('Claude Code could not start'))
    const store = new CommandCatalogStore(load, 1000)
    store.request(PATH)
    await vi.advanceTimersByTimeAsync(1000)
    expect(store.get(PATH)).toMatchObject({ updating: false, error: null })
    expect(names(store)).toEqual(['compact'])

    store.request('/commands')
    await vi.advanceTimersByTimeAsync(0)
    expect(store.get('/commands')).toMatchObject({ commands: null, error: 'Claude Code could not start' })
  })
})
