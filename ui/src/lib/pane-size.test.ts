import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clampWidth,
  forgetWidth,
  keyedWidth,
  KEY_STEP,
  PAGE_STEP,
  PANES,
  storedWidth,
  storeWidth,
} from '@/lib/pane-size'

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

const list = PANES.agents

let storage: MemoryStorage

beforeEach(() => {
  storage = new MemoryStorage()
  vi.stubGlobal('localStorage', storage)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('clampWidth', () => {
  it('keeps a width between the pane minimum and maximum', () => {
    expect(clampWidth(100, list)).toBe(list.min)
    expect(clampWidth(5000, list)).toBe(list.max)
    expect(clampWidth(333.4, list)).toBe(333)
  })

  it('leaves the main area its share of a narrow row', () => {
    expect(clampWidth(560, list, 1000)).toBe(450)
  })

  it('never goes below the minimum, even in a row too narrow for it', () => {
    expect(clampWidth(560, list, 300)).toBe(list.min)
  })
})

describe('stored widths', () => {
  it('starts at the initial width and remembers a resize per pane', () => {
    expect(storedWidth(list)).toBe(list.initial)
    storeWidth(list, 401.6)
    expect(storage.getItem('seti.pane.agents-list')).toBe('402')
    expect(storedWidth(list)).toBe(402)
    expect(storedWidth(PANES.team)).toBe(PANES.team.initial)
  })

  it('clamps a stored width that falls outside the limits', () => {
    storage.setItem('seti.pane.agents-list', '99999')
    expect(storedWidth(list)).toBe(list.max)
  })

  it('ignores a value that is not a number', () => {
    storage.setItem('seti.pane.agents-list', 'wide')
    expect(storedWidth(list)).toBe(list.initial)
  })

  it('forgets the width on reset', () => {
    storeWidth(list, 400)
    forgetWidth(list)
    expect(storedWidth(list)).toBe(list.initial)
  })

  it('falls back to the initial width when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    expect(storedWidth(list)).toBe(list.initial)
    expect(() => {
      storeWidth(list, 400)
    }).not.toThrow()
  })
})

describe('keyedWidth', () => {
  const at = { width: 320, room: 0 }

  it('grows a start pane with the right arrow and an end pane with the left arrow', () => {
    expect(keyedWidth('ArrowRight', list, 'start', at)).toBe(320 + KEY_STEP)
    expect(keyedWidth('ArrowLeft', list, 'start', at)).toBe(320 - KEY_STEP)
    expect(keyedWidth('ArrowLeft', PANES.team, 'end', at)).toBe(320 + KEY_STEP)
    expect(keyedWidth('ArrowRight', PANES.team, 'end', at)).toBe(320 - KEY_STEP)
    expect(keyedWidth('ArrowRight', PANES.team, 'end', { width: 285, room: 0 })).toBe(PANES.team.min)
  })

  it('steps further with Page keys and jumps to the ends with Home and End', () => {
    expect(keyedWidth('PageUp', list, 'start', at)).toBe(320 + PAGE_STEP)
    expect(keyedWidth('Home', list, 'start', at)).toBe(list.min)
    expect(keyedWidth('End', list, 'start', at)).toBe(list.max)
    expect(keyedWidth('End', list, 'start', { width: 320, room: 1000 })).toBe(450)
  })

  it('leaves other keys alone', () => {
    expect(keyedWidth('Enter', list, 'start', at)).toBeNull()
    expect(keyedWidth('ArrowUp', list, 'start', at)).toBeNull()
  })
})
