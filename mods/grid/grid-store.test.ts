import type { WorkspaceGrid } from '@seti/mod-api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GRID_KEY, readGridStore } from './grid-cache'

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }))

vi.mock('./seti', () => ({
  seti: () => ({
    request: (method: string, path: string, body?: unknown): unknown =>
      method === 'GET' ? api.get(path) : api.put(path, body),
    app: { every: () => () => undefined },
  }),
}))

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
  vi.useFakeTimers()
  storage = new MemoryStorage()
  vi.stubGlobal('localStorage', storage)
  vi.resetModules()
  api.get.mockReset().mockResolvedValue([])
  api.put.mockReset().mockImplementation(async (path: string, body: { layout: WorkspaceGrid['layout'] }) => {
    const id = path.split('/')[2] ?? ''
    const revision = (revisions.get(id) ?? 0) + 1
    return Promise.resolve(grid(id, body.layout.panels, revision, body.layout))
  })
  revisions.clear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const revisions = new Map<string, number>()

type StoredPanel = WorkspaceGrid['layout']['panels'][number]

function grid(
  id: string,
  panels: readonly StoredPanel[],
  revision: number,
  { locked = false, perScreen = null }: Partial<WorkspaceGrid['layout']> = {},
): WorkspaceGrid {
  revisions.set(id, revision)
  const layout = { panels: [...panels], locked, perScreen }
  return { workspace_id: id, layout, revision, updated_at: '2026-10-13T10:00:00.000Z' }
}

const LAYOUT = { locked: false, perScreen: null, recent: [], revision: 0, dirty: false }

const stored = () => JSON.parse(storage.getItem(GRID_KEY) ?? 'null') as Record<string, unknown>

const PANELS = [
  { i: 'p1', agent: 'a', x: 0, y: 0, w: 6, h: 24 },
  { i: 'p2', agent: 'b', x: 6, y: 0, w: 6, h: 24 },
]

describe('readGridStore', () => {
  it('starts off with no grids', () => {
    expect(readGridStore()).toEqual({ enabled: false, layouts: {}, unclaimed: null })
  })

  it('reads back each workspace grid and drops unreadable ones', () => {
    const own = { panels: PANELS, locked: true, perScreen: 3, focused: 'p2', recent: ['b'] }
    storage.setItem(GRID_KEY, JSON.stringify({ v: 3, enabled: true, workspaces: { w1: own, w2: { panels: 'x' } } }))
    expect(readGridStore()).toEqual({
      enabled: true,
      layouts: { w1: { ...own, revision: 0, dirty: false } },
      unclaimed: null,
    })
  })

  it('keeps the one grid from before workspaces unclaimed', () => {
    storage.setItem(GRID_KEY, JSON.stringify({ v: 2, enabled: true, panels: PANELS, locked: true, focused: 'p2' }))
    expect(readGridStore()).toEqual({
      enabled: true,
      layouts: {},
      unclaimed: { ...LAYOUT, panels: PANELS, locked: true, focused: 'p2' },
    })
  })

  it('migrates the rows-and-columns grid, keeping placed agents and focus', () => {
    const layout = { rows: 1, cols: 2, colSizes: [0.5, 0.5], rowSizes: [1], cells: ['a', 'b'] }
    storage.setItem(GRID_KEY, JSON.stringify({ enabled: true, layout, focused: 1, recent: ['b', 'a'] }))
    expect(readGridStore()).toEqual({
      enabled: true,
      layouts: {},
      unclaimed: { ...LAYOUT, panels: PANELS, focused: 'p2', recent: ['b', 'a'] },
    })
  })

  it('reads back what the server last had and what this device has not saved yet', () => {
    const own = { panels: PANELS, locked: false, perScreen: null, focused: 'p1', recent: [] }
    const workspaces = { w1: { ...own, revision: 4, dirty: true }, w2: { ...own, perScreen: 9, revision: -1 } }
    storage.setItem(GRID_KEY, JSON.stringify({ v: 4, enabled: false, workspaces }))
    expect(readGridStore().layouts).toEqual({
      w1: { ...own, revision: 4, dirty: true },
      w2: { ...own, revision: 0, dirty: false },
    })
    storage.setItem(GRID_KEY, JSON.stringify({ v: 3, enabled: false, workspaces }))
    expect(readGridStore().layouts.w1).toEqual({ ...own, revision: 0, dirty: false })
  })

  it('falls back on broken or foreign values', () => {
    storage.setItem(GRID_KEY, '{not json')
    expect(readGridStore().enabled).toBe(false)
    storage.setItem(GRID_KEY, JSON.stringify({ enabled: true, layout: { rows: 9 } }))
    expect(readGridStore().enabled).toBe(false)
    storage.setItem(GRID_KEY, JSON.stringify({ v: 2, enabled: true, panels: 'none' }))
    expect(readGridStore().enabled).toBe(false)
    const panels = [{ i: 'p1', agent: 'a', x: 0, y: 0, w: 12, h: 24 }]
    storage.setItem(GRID_KEY, JSON.stringify({ v: 2, enabled: true, panels, focused: 'p7', recent: [1, 'a'] }))
    expect(readGridStore().unclaimed).toMatchObject({ focused: 'p1', recent: ['a'] })
  })
})

describe('gridStore', () => {
  it('opens agents into panels, focuses them, and saves the new shape', async () => {
    const { gridStore } = await import('./grid-store')
    gridStore.measure({ width: 1100, height: 850 })
    gridStore.setEnabled(true)
    const first = gridStore.open('a')
    const second = gridStore.open('b')
    expect(gridStore.open('a')).toBe(first)
    gridStore.focus(second)
    expect(stored()).toMatchObject({
      v: 4,
      enabled: true,
      unclaimed: {
        focused: second,
        recent: ['b'],
        panels: [
          { i: first, agent: 'a', x: 0, y: 0, w: 6, h: 24 },
          { i: second, agent: 'b', x: 6, y: 0, w: 6, h: 24 },
        ],
      },
    })
    gridStore.focus('p9')
    expect(gridStore.getSnapshot().focused).toBe(second)
  })

  it('locks, removes, clears and restores', async () => {
    const { gridStore } = await import('./grid-store')
    gridStore.measure({ width: 1100, height: 850 })
    const first = gridStore.open('a')
    const second = gridStore.open('b')
    gridStore.setLocked(true)
    gridStore.focus(second)
    gridStore.remove(second)
    expect(gridStore.getSnapshot()).toMatchObject({ locked: true, focused: first, panels: [{ agent: 'a' }] })
    const before = gridStore.clear()
    expect(gridStore.getSnapshot()).toMatchObject({ panels: [], focused: null })
    gridStore.restore(before)
    expect(gridStore.getSnapshot().panels).toHaveLength(1)
    expect(stored()).toMatchObject({ unclaimed: { locked: true, panels: [{ agent: 'a' }] } })
  })

  it('keeps terminal tiles in the saved layout, named, tidied and read back after a reload', async () => {
    const { gridStore } = await import('./grid-store')
    gridStore.measure({ width: 1100, height: 850 })
    gridStore.showWorkspace('main', 'main')
    gridStore.open('a')
    const shell = { id: 't1', name: 'Terminal', task: null }
    const tile = gridStore.openTerminal(shell)
    expect(gridStore.openTerminal(shell)).toBe(tile)
    gridStore.renameTerminal(tile, 'build')
    gridStore.setPerScreen(1)
    const panels = gridStore.getSnapshot().panels
    expect(panels.map((panel) => [panel.agent, panel.terminal?.name ?? null, panel.y])).toEqual([
      ['a', null, 0],
      [null, 'build', 24],
    ])
    await vi.runAllTimersAsync()
    const sent = api.put.mock.calls.at(-1)?.[1] as { layout: WorkspaceGrid['layout'] } | undefined
    expect(sent?.layout.panels[1]).toMatchObject({ agent: null, terminal: { id: 't1', name: 'build', task: null } })

    vi.resetModules()
    const reloaded = (await import('./grid-store')).gridStore
    reloaded.showWorkspace('main', 'main')
    expect(reloaded.getSnapshot().panels).toEqual(panels)
  })

  it('tidies to the measured window', async () => {
    const { gridStore } = await import('./grid-store')
    gridStore.measure({ width: 1100, height: 850 })
    for (const agent of ['a', 'b', 'c', 'd', 'e', 'f']) {
      gridStore.open(agent)
    }
    gridStore.tidy()
    const bottoms = gridStore.getSnapshot().panels.map((panel) => panel.y + panel.h)
    expect(Math.max(...bottoms)).toBe(24)
  })

  it('keeps a grid per workspace, the first taking the one from before workspaces', async () => {
    storage.setItem(GRID_KEY, JSON.stringify({ v: 2, enabled: true, panels: PANELS, focused: 'p1' }))
    const { gridStore } = await import('./grid-store')
    gridStore.measure({ width: 1100, height: 850 })
    gridStore.showWorkspace('side', 'main')
    expect(gridStore.getSnapshot()).toMatchObject({ enabled: true, panels: [] })
    gridStore.open('c')
    gridStore.showWorkspace('main', 'main')
    expect(gridStore.getSnapshot().panels.map((panel) => panel.agent)).toEqual(['a', 'b'])
    gridStore.setEnabled(false)
    gridStore.showWorkspace('side', 'main')
    expect(gridStore.getSnapshot()).toMatchObject({ enabled: false, panels: [{ agent: 'c' }] })
    expect(stored()).toMatchObject({
      v: 4,
      workspaces: { main: { panels: [{ agent: 'a' }, { agent: 'b' }] }, side: { panels: [{ agent: 'c' }] } },
    })
    expect(stored().unclaimed).toBeUndefined()
  })

  it('shows the workspace Seti names before it knows the first one', async () => {
    const side = { panels: [PANELS[0]], locked: false, focused: 'p1', recent: [] }
    storage.setItem(GRID_KEY, JSON.stringify({ v: 3, enabled: true, workspaces: { side } }))
    const { gridStore, isInGrid } = await import('./grid-store')
    gridStore.showWorkspace('side', null)
    expect(gridStore.getSnapshot().panels).toEqual([PANELS[0]])
    expect(isInGrid('a')).toBe(true)
  })
})

describe('grids on the server', () => {
  const load = async (chosen: string) => {
    const store = await import('./grid-store')
    store.gridStore.measure({ width: 1100, height: 850 })
    store.gridStore.showWorkspace(chosen, chosen)
    return store
  }

  it('saves a burst of edits as one request once they settle, and focus not at all', async () => {
    const { gridStore } = await load('w1')
    const first = gridStore.open('a')
    gridStore.open('b')
    gridStore.tidy()
    gridStore.setLocked(true)
    await vi.advanceTimersByTimeAsync(799)
    expect(api.put).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(api.put).toHaveBeenCalledTimes(1)
    expect(api.put).toHaveBeenCalledWith('/layouts/w1', {
      layout: { panels: gridStore.getSnapshot().panels, locked: true, perScreen: null },
    })
    expect(stored()).toMatchObject({ workspaces: { w1: { revision: 1, dirty: false } } })

    gridStore.focus(first)
    gridStore.setEnabled(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(api.put).toHaveBeenCalledTimes(1)
  })

  it('tidies to the chosen template, evens out its short screen as panels open and saves it', async () => {
    const { gridStore } = await load('w1')
    for (const agent of ['a', 'b', 'c']) {
      gridStore.open(agent)
    }
    gridStore.setPerScreen(3)
    const rect = (p: StoredPanel) => [p.x, p.y, p.w, p.h]
    expect(gridStore.getSnapshot().panels.map(rect)).toEqual([
      [0, 0, 4, 24],
      [4, 0, 4, 24],
      [8, 0, 4, 24],
    ])
    gridStore.open('d')
    expect(
      gridStore
        .getSnapshot()
        .panels.map(rect)
        .slice(0, 3)
        .every(([, , w]) => w === 4),
    ).toBe(true)
    expect(gridStore.getSnapshot().panels.find((p) => p.agent === 'd')).toMatchObject({ x: 0, y: 24, w: 12, h: 24 })
    gridStore.open('e')
    expect(gridStore.getSnapshot().panels.map(rect).slice(3)).toEqual([
      [0, 24, 6, 24],
      [6, 24, 6, 24],
    ])
    await vi.advanceTimersByTimeAsync(800)
    expect(api.put).toHaveBeenCalledWith('/layouts/w1', {
      layout: { panels: gridStore.getSnapshot().panels, locked: false, perScreen: 3 },
    })
    expect(stored()).toMatchObject({ workspaces: { w1: { perScreen: 3, dirty: false } } })
  })

  it("takes another device's grid, but not over a drag until it ends", async () => {
    const { gridStore } = await load('w1')
    api.get.mockResolvedValueOnce([grid('w1', PANELS, 2)])
    await gridStore.refresh()
    expect(gridStore.getSnapshot().panels).toEqual(PANELS)

    gridStore.hold('drag', true)
    api.get.mockResolvedValueOnce([grid('w1', PANELS.slice(0, 1), 3, { locked: true })])
    await gridStore.refresh()
    expect(gridStore.getSnapshot()).toMatchObject({ panels: PANELS, locked: false })
    gridStore.hold('drag', false)
    expect(gridStore.getSnapshot()).toMatchObject({ panels: PANELS.slice(0, 1), locked: true })
    expect(api.put).not.toHaveBeenCalled()
  })

  it('sends up the grid this device had before, once, then follows the server', async () => {
    const own = { panels: PANELS, locked: false, focused: 'p2', recent: [] }
    storage.setItem(GRID_KEY, JSON.stringify({ v: 3, enabled: true, workspaces: { w1: own, w2: own } }))
    const { gridStore } = await load('w1')
    api.get.mockResolvedValueOnce([grid('w2', [], 5)])
    await gridStore.refresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.put).toHaveBeenCalledTimes(1)
    expect(api.put).toHaveBeenCalledWith('/layouts/w1', {
      layout: { panels: PANELS, locked: false, perScreen: null },
    })
    expect(stored()).toMatchObject({ workspaces: { w1: { revision: 1, dirty: false }, w2: { panels: [] } } })

    api.get.mockResolvedValueOnce([grid('w1', PANELS, 1), grid('w2', [], 5)])
    await gridStore.refresh()
    await vi.advanceTimersByTimeAsync(5000)
    expect(api.put).toHaveBeenCalledTimes(1)
    expect(gridStore.getSnapshot()).toMatchObject({ panels: PANELS, focused: 'p2' })
  })

  it('keeps an edit the server did not take and sends it again', async () => {
    const { gridStore } = await load('w1')
    api.put.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    gridStore.open('a')
    await vi.advanceTimersByTimeAsync(800)
    expect(stored()).toMatchObject({ workspaces: { w1: { dirty: true } } })
    api.get.mockResolvedValueOnce([grid('w1', [], 7)])
    await gridStore.refresh()
    expect(gridStore.getSnapshot().panels).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(api.put).toHaveBeenCalledTimes(2)
    expect(stored()).toMatchObject({ workspaces: { w1: { revision: 8, dirty: false } } })
  })

  it('does not take an answer from before a save landed, and asks again', async () => {
    const { gridStore } = await load('w1')
    const answers: ((rows: WorkspaceGrid[]) => void)[] = []
    api.get.mockImplementationOnce(
      async () =>
        new Promise<WorkspaceGrid[]>((resolve) => {
          answers.push(resolve)
        }),
    )
    const refreshing = gridStore.refresh()
    gridStore.open('a')
    await vi.advanceTimersByTimeAsync(800)
    expect(api.put).toHaveBeenCalledTimes(1)
    const saved = gridStore.getSnapshot().panels
    api.get.mockResolvedValueOnce([grid('w1', saved, 1)])
    answers[0]?.([grid('w1', [], 0)])
    await refreshing
    await vi.advanceTimersByTimeAsync(0)
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(gridStore.getSnapshot().panels).toEqual(saved)
  })

  it('empties panels of agents this device no longer lists without saving that', async () => {
    const { gridStore } = await load('w1')
    api.get.mockResolvedValueOnce([grid('w1', PANELS, 2)])
    await gridStore.refresh()
    gridStore.prune(new Set(['a']))
    expect(gridStore.getSnapshot().panels.map((panel) => panel.agent)).toEqual(['a', null])
    await vi.advanceTimersByTimeAsync(5000)
    expect(api.put).not.toHaveBeenCalled()
  })
})
