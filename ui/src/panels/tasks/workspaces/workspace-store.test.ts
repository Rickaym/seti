import { listedSubtasks, prStates, type TaskListEntry, type TaskStatus } from '@seti/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { needsYouByWorkspace, needsYouWorkspace, resolveWorkspace, WORKSPACE_KEY } from './workspace-store'

const agent = (id: string, workspace_id: string, status: TaskStatus, updated_at = '2026-10-01T00:00:00Z') =>
  ({
    id,
    workspace_id,
    status,
    updated_at,
    unseen: true,
    pr_urls: [],
    pr_states: prStates({}),
    ...listedSubtasks([]),
  }) as unknown as TaskListEntry

describe('resolveWorkspace', () => {
  const list = [{ id: 'main' }, { id: 'side' }]

  it('keeps the chosen workspace while it exists and falls back to the first', () => {
    expect(resolveWorkspace(list, 'side')).toEqual({ id: 'side' })
    expect(resolveWorkspace(list, 'gone')).toEqual({ id: 'main' })
    expect(resolveWorkspace(list, null)).toEqual({ id: 'main' })
    expect(resolveWorkspace([], 'side')).toBeNull()
  })
})

describe('needs you by workspace', () => {
  const tasks = [
    agent('a', 'main', 'error', '2026-10-01T00:00:00Z'),
    agent('b', 'side', 'interrupted', '2026-10-03T00:00:00Z'),
    agent('c', 'side', 'error', '2026-10-02T00:00:00Z'),
    agent('d', 'side', 'idle'),
    agent('e', 'quiet', 'running'),
    { ...agent('f', 'quiet', 'error', '2026-10-04T00:00:00Z'), unseen: false },
  ]

  it('counts the agents that need the user in each workspace', () => {
    expect(needsYouByWorkspace(tasks)).toEqual(
      new Map([
        ['main', 1],
        ['side', 2],
      ]),
    )
  })

  it('stays in the shown workspace when it has some, else goes to the newest failure', () => {
    expect(needsYouWorkspace(tasks, 'main')).toBe('main')
    expect(needsYouWorkspace(tasks, 'quiet')).toBe('side')
    expect(needsYouWorkspace([agent('d', 'side', 'idle')], 'quiet')).toBe('quiet')
  })
})

describe('chooseWorkspace', () => {
  const items = new Map<string, string>()

  beforeEach(() => {
    items.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
    })
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('remembers the choice on this device', async () => {
    const store = await import('./workspace-store')
    expect(store.chosenWorkspace()).toBeNull()
    store.chooseWorkspace('side')
    expect(items.get(WORKSPACE_KEY)).toBe('side')
    vi.resetModules()
    expect((await import('./workspace-store')).chosenWorkspace()).toBe('side')
  })

  it('works when storage is blocked', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    const store = await import('./workspace-store')
    store.chooseWorkspace('side')
    expect(store.chosenWorkspace()).toBe('side')
  })
})
