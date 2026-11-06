import { LayoutGrid } from 'lucide-react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  activeLayout,
  agentsLayouts,
  setLayoutActive,
  showLayoutsWorkspace,
  type AgentsLayout,
} from '@/panels/tasks/agents-layouts'

vi.mock('@/lib/route', () => ({ TERMINAL_ROUTE: 'terminal' }))

const disposers: (() => void)[] = []

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose()
  }
})

function layout(key: string, phone: boolean): AgentsLayout & { changes: () => number; workspaces: string[] } {
  const workspaces: string[] = []
  let on = false
  let changes = 0
  const listeners = new Set<() => void>()
  const entry = {
    key,
    title: key,
    icon: LayoutGrid,
    active: {
      get: () => on,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    setActive: (next: boolean) => {
      on = next
      changes += 1
      for (const listener of listeners) {
        listener()
      }
    },
    hint: (shown: boolean) => (shown ? 'Back to one agent' : `Show ${key}`),
    phone,
    view: () => null,
    shows: ({ id, listed }: { id: string | null; listed: boolean }) => id === null || listed,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    shownAgents: () => [],
    acceptsAgents: true,
    overlay: false,
    showWorkspace: (workspace: { id: string; first: string | null }) => {
      workspaces.push(workspace.id)
    },
    workspaces,
    changes: () => changes,
  }
  disposers.push(agentsLayouts.register(entry))
  return entry
}

describe('the Agents layout slot', () => {
  it('shows one agent at a time until a layout is on, and again once it is disposed', () => {
    expect(activeLayout(false)).toBeNull()
    const grid = layout('test.grid', false)
    expect(activeLayout(false)).toBeNull()
    setLayoutActive(grid, true)
    expect(activeLayout(false)).toBe(grid)
    disposers.splice(0).forEach((dispose) => {
      dispose()
    })
    expect(activeLayout(false)).toBeNull()
  })

  it('keeps at most one layout on: turning one on turns the others off', () => {
    const grid = layout('test.grid', false)
    const columns = layout('test.columns', true)
    setLayoutActive(grid, true)
    setLayoutActive(columns, true)
    expect(grid.active.get()).toBe(false)
    expect(activeLayout(false)).toBe(columns)
    setLayoutActive(columns, false)
    expect(activeLayout(false)).toBeNull()
    expect(grid.changes()).toBe(2)
  })

  it('never offers a desktop-only layout on a narrow screen', () => {
    const grid = layout('test.grid', false)
    setLayoutActive(grid, true)
    expect(activeLayout(true)).toBeNull()
    expect(activeLayout(false)).toBe(grid)
  })

  it('takes a key once, so a layout cannot shadow another', () => {
    layout('test.grid', false)
    expect(() => layout('test.grid', true)).toThrow('already registered')
  })

  it('tells every layout the shown workspace, and one registered later too', () => {
    const grid = layout('test.grid', false)
    showLayoutsWorkspace('w1', 'w1')
    const columns = layout('test.columns', true)
    showLayoutsWorkspace('w2', 'w1')
    expect(grid.workspaces).toEqual(['w1', 'w2'])
    expect(columns.workspaces).toEqual(['w1', 'w2'])
  })
})
