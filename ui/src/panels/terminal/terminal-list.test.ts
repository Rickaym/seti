import { describe, expect, it } from 'vitest'
import {
  EMPTY_LIST,
  HOME_PLACE,
  parseList,
  placeFor,
  renamed,
  uniqueName,
  withoutTerminal,
  withTerminal,
  type TerminalList,
} from './terminal-list'

const agent = { taskId: 't1', name: 'Fix login' }

const listOf = (...ids: string[]): TerminalList =>
  ids.reduce(
    (list, id) => withTerminal(list, { id, name: uniqueName(list.terminals, 'Terminal'), task: null }),
    EMPTY_LIST,
  )

describe('placeFor', () => {
  it("opens in the agent's folder on its page and in the home folder anywhere else", () => {
    const tasks = [{ id: 't1', title: 'Fix login' }]
    expect(placeFor({ section: 'agents', id: 't1' }, tasks)).toEqual(agent)
    expect(placeFor({ section: 'agents', id: 'gone' }, tasks)).toEqual(HOME_PLACE)
    expect(placeFor({ section: 'agents', id: null }, tasks)).toEqual(HOME_PLACE)
    expect(placeFor({ section: 'settings', id: 't1' }, tasks)).toEqual(HOME_PLACE)
  })
})

describe('terminal list', () => {
  it('adds a terminal once, names it apart and makes it the recent one', () => {
    const list = listOf('a', 'b', 'c')
    expect(list.terminals.map((t) => t.name)).toEqual(['Terminal', 'Terminal 2', 'Terminal 3'])
    expect(list.recent).toBe('c')
    const again = withTerminal(list, { id: 'a', name: 'other', task: null })
    expect(again.terminals).toBe(list.terminals)
    expect(again.recent).toBe('a')
  })

  it('stops at 16 terminals', () => {
    const full = listOf(...Array.from({ length: 16 }, (_, n) => String(n)))
    expect(withTerminal(full, { id: 'x', name: 'x', task: null })).toBe(full)
  })

  it('makes the neighbour of a dropped recent terminal the recent one', () => {
    let list: TerminalList = { ...listOf('a', 'b', 'c'), recent: 'b' }
    list = withoutTerminal(list, 'b')
    expect(list.recent).toBe('c')
    list = withoutTerminal(list, 'c')
    expect(list.recent).toBe('a')
    expect(withoutTerminal(list, 'a')).toEqual(EMPTY_LIST)
    expect(withoutTerminal(list, 'gone')).toBe(list)
  })

  it('renames a terminal, keeping the old name for a blank one', () => {
    const list = renamed(listOf('a'), 'a', '  build  ')
    expect(list.terminals[0]?.name).toBe('build')
    expect(renamed(list, 'a', '   ')).toBe(list)
  })

  it('numbers repeated names and falls back to Terminal for a blank one', () => {
    expect(uniqueName(listOf('a', 'b').terminals, 'Terminal')).toBe('Terminal 3')
    expect(uniqueName([], ' ')).toBe('Terminal')
  })
})

describe('parseList', () => {
  it('reads back a stored list and drops what it cannot use', () => {
    const stored = { ...listOf('a', 'b'), recent: 'a' }
    expect(parseList(JSON.stringify(stored))).toEqual(stored)
    expect(parseList(JSON.stringify({ terminals: [{ id: 'a' }, 7], recent: 'x' }))).toEqual(EMPTY_LIST)
    expect(parseList('not json')).toEqual(EMPTY_LIST)
    expect(parseList(null)).toEqual(EMPTY_LIST)
  })

  it('takes the tabs of the old terminal dock as terminals, its active tab as the recent one', () => {
    const dock = {
      open: true,
      size: 'maximized',
      height: 480,
      tabs: [
        { id: 'a', name: 'Home', taskId: null, cwd: '/home/me', sandboxed: false },
        { id: 'b', name: 'Fix login', taskId: 't1', cwd: '/repo', sandboxed: true },
      ],
      active: 'b',
    }
    expect(parseList(JSON.stringify(dock))).toEqual({
      terminals: [
        { id: 'a', name: 'Home', task: null },
        { id: 'b', name: 'Fix login', task: 't1' },
      ],
      recent: 'b',
    })
  })

  it('takes the last terminal as the recent one when the stored one is gone', () => {
    expect(parseList(JSON.stringify({ ...listOf('a', 'b'), recent: 'gone' })).recent).toBe('b')
  })
})
