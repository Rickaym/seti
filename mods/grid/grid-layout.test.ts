import { describe, expect, it } from 'vitest'
import {
  addPanel,
  assign,
  COLS,
  evenSpans,
  fit,
  freeSpot,
  metrics,
  movePanel,
  neighbour,
  nextSlot,
  prune,
  removePanel,
  renamedTerminal,
  resizePanel,
  ROWS,
  samePanels,
  settle,
  tidy,
  rowSizes,
  templateAcross,
  tidyTemplate,
  withTerminal,
  type Panel,
} from './grid-layout'
import { livePanels, streamBudget } from './grid-streams'

/** 1100 by 850 pixels, about a 1440 by 900 window beside the agent list. */
const LAPTOP = metrics({ width: 1100, height: 850 })
const WIDE = metrics({ width: 2250, height: 1380 })

type Box = [x: number, y: number, w: number, h: number]

const panel = (i: string, [x, y, w, h]: Box, agent: string | null = i): Panel => ({ i, agent, x, y, w, h })

const tile = (i: string, box: Box, name = 'Terminal'): Panel => ({
  ...panel(i, box, null),
  terminal: { id: `t-${i}`, name, task: null },
})

const rects = (panels: readonly Panel[]) => Object.fromEntries(panels.map((p) => [p.i, [p.x, p.y, p.w, p.h]]))

describe('metrics', () => {
  it('turns the minimum panel size into grid units for the window', () => {
    expect(LAPTOP).toMatchObject({ minW: 4, minH: 8 })
    expect(WIDE).toMatchObject({ minW: 2, minH: 5 })
    expect(metrics({ width: 200, height: 100 }).minW).toBe(COLS)
  })
})

describe('settle', () => {
  it('floats panels up into the space above them', () => {
    const settled = settle([panel('a', [0, 5, 6, 4]), panel('b', [6, 9, 6, 4])])
    expect(rects(settled)).toEqual({ a: [0, 0, 6, 4], b: [6, 0, 6, 4] })
  })

  it('pushes overlapping panels below the one held still', () => {
    const settled = settle([panel('a', [0, 0, 12, 4]), panel('b', [0, 2, 6, 4])], 'b')
    expect(rects(settled)).toEqual({ a: [0, 4, 12, 4], b: [0, 0, 6, 4] })
  })
})

describe('fit', () => {
  it('grows panels to the minimum size and keeps them inside the columns', () => {
    const fitted = fit([panel('a', [10, 0, 2, 2]), panel('b', [0, 0, 4, 12])], LAPTOP)
    expect(rects(fitted)).toEqual({ a: [8, 0, 4, 8], b: [0, 0, 4, 12] })
  })
})

describe('movePanel', () => {
  const row = [panel('a', [0, 0, 4, 24]), panel('b', [4, 0, 4, 24]), panel('c', [8, 0, 4, 24])]

  it('trades places with the panel beside it', () => {
    expect(rects(movePanel(row, 'a', 'right'))).toEqual({ a: [4, 0, 4, 24], b: [0, 0, 4, 24], c: [8, 0, 4, 24] })
    expect(rects(movePanel(row, 'c', 'left'))).toEqual({ a: [0, 0, 4, 24], b: [8, 0, 4, 24], c: [4, 0, 4, 24] })
  })

  it('keeps each width when neighbours differ in size', () => {
    const pair = [panel('a', [0, 0, 4, 12]), panel('b', [4, 0, 8, 12])]
    expect(rects(movePanel(pair, 'a', 'right'))).toEqual({ a: [8, 0, 4, 12], b: [0, 0, 8, 12] })
  })

  it('slides to the edge when nothing is beside it, and holds there', () => {
    const lone = [panel('a', [0, 0, 6, 12])]
    expect(rects(movePanel(lone, 'a', 'right'))).toEqual({ a: [6, 0, 6, 12] })
    expect(rects(movePanel(lone, 'a', 'left'))).toEqual({ a: [0, 0, 6, 12] })
    expect(rects(movePanel(lone, 'a', 'up'))).toEqual({ a: [0, 0, 6, 12] })
  })

  it('trades rows with the panel above or below', () => {
    const stack = [panel('a', [0, 0, 12, 12]), panel('b', [0, 12, 12, 8])]
    expect(rects(movePanel(stack, 'b', 'up'))).toEqual({ a: [0, 8, 12, 12], b: [0, 0, 12, 8] })
    expect(rects(movePanel(stack, 'a', 'down'))).toEqual({ a: [0, 8, 12, 12], b: [0, 0, 12, 8] })
  })
})

describe('resizePanel', () => {
  it('grows and shrinks by a unit, pushing what it covers down', () => {
    const pair = [panel('a', [0, 0, 6, 12]), panel('b', [6, 0, 6, 12])]
    expect(rects(resizePanel(pair, 'a', 'right', LAPTOP))).toEqual({ a: [0, 0, 7, 12], b: [6, 12, 6, 12] })
    expect(rects(resizePanel(pair, 'a', 'down', LAPTOP))).toEqual({ a: [0, 0, 6, 13], b: [6, 0, 6, 12] })
    expect(rects(resizePanel(pair, 'a', 'left', LAPTOP))).toEqual({ a: [0, 0, 5, 12], b: [6, 0, 6, 12] })
  })

  it('stops at the minimum size and grows leftward from the right edge', () => {
    const small = [panel('a', [8, 0, 4, 8])]
    expect(rects(resizePanel(small, 'a', 'left', LAPTOP))).toEqual({ a: [8, 0, 4, 8] })
    expect(rects(resizePanel(small, 'a', 'up', LAPTOP))).toEqual({ a: [8, 0, 4, 8] })
    expect(rects(resizePanel(small, 'a', 'right', LAPTOP))).toEqual({ a: [7, 0, 5, 8] })
  })
})

describe('addPanel', () => {
  it('fills the screen first, then halves the largest panel along its long side', () => {
    let panels: Panel[] = []
    for (const agent of ['a', 'b', 'c', 'd']) {
      panels = addPanel(panels, agent, LAPTOP).panels
    }
    expect(rects(panels)).toEqual({
      p1: [0, 0, 6, 12],
      p2: [6, 0, 6, 12],
      p3: [0, 12, 6, 12],
      p4: [6, 12, 6, 12],
    })
    expect(panels.map((p) => p.agent)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('takes a hole on screen before splitting', () => {
    const panels = [panel('p1', [0, 0, 6, 24]), panel('p2', [6, 0, 6, 12])]
    expect(addPanel(panels, 'x', LAPTOP)).toMatchObject({ id: 'p3', panels: [{}, {}, { x: 6, y: 12, w: 6, h: 12 }] })
  })

  it('goes below once no panel can be halved', () => {
    const quarters = [panel('p1', [0, 0, 6, 12]), panel('p2', [6, 0, 6, 12]), panel('p3', [0, 12, 6, 12])]
    const four = [...quarters, panel('p4', [6, 12, 6, 12])]
    const added = addPanel(four, 'x', LAPTOP)
    expect(added.panels.at(-1)).toMatchObject({ x: 0, y: 24, w: 6, h: 12 })
  })

  it('lands where dropped, at least the minimum size, and the others reflow', () => {
    const panels = [panel('p1', [0, 0, 12, 12])]
    const added = addPanel(panels, 'x', LAPTOP, { x: 3, y: 0, w: 2, h: 3 })
    expect(rects(added.panels)).toEqual({ p1: [0, 8, 12, 12], p2: [3, 0, 4, 8] })
  })
})

describe('freeSpot', () => {
  it('finds nothing in a full screen', () => {
    expect(freeSpot([panel('a', [0, 0, COLS, ROWS])], LAPTOP)).toBeNull()
  })
})

describe('tidy', () => {
  const count = (n: number) => Array.from({ length: n }, (_, k) => panel(`p${String(k + 1)}`, [0, k * 4, 4, 4]))
  const shape = (panels: readonly Panel[]) => {
    const tops = [...new Set(panels.map((p) => p.y))]
    return tops.map((y) => panels.filter((p) => p.y === y).length)
  }

  it('lays panels out in even rows that fill the window', () => {
    expect(shape(tidy(count(2), LAPTOP))).toEqual([2])
    expect(shape(tidy(count(3), LAPTOP))).toEqual([2, 1])
    expect(shape(tidy(count(4), LAPTOP))).toEqual([2, 2])
    expect(shape(tidy(count(9), LAPTOP))).toEqual([3, 3, 3])
    expect(shape(tidy(count(9), WIDE))).toEqual([3, 3, 3])
    const five = tidy(count(5), LAPTOP)
    expect(shape(five)).toEqual([3, 2])
    expect(five.filter((p) => p.y > 0).map((p) => p.w)).toEqual([6, 6])
    expect(Math.max(...tidy(count(6), LAPTOP).map((p) => p.y + p.h))).toBe(ROWS)
  })

  it('splits units as evenly as whole units allow', () => {
    expect(evenSpans(12, 5)).toEqual([3, 3, 2, 2, 2])
  })

  it('keeps reading order and the minimum size when the window is too small', () => {
    const tidied = tidy(count(12), LAPTOP)
    expect(tidied.every((p) => p.w >= LAPTOP.minW && p.h >= LAPTOP.minH)).toBe(true)
    expect(tidied[0]).toMatchObject({ x: 0, y: 0 })
  })
})

describe('templates', () => {
  const count = (n: number) => Array.from({ length: n }, (_, k) => panel(`p${String(k + 1)}`, [0, k * 4, 4, 4]))
  const boxes = (panels: readonly Panel[]) => panels.map((p) => [p.x, p.y, p.w, p.h])

  it('fills each screen with the template and puts the rest on the screens below', () => {
    expect(boxes(tidyTemplate(count(5), 3, LAPTOP))).toEqual([
      [0, 0, 4, 24],
      [4, 0, 4, 24],
      [8, 0, 4, 24],
      [0, 24, 6, 24],
      [6, 24, 6, 24],
    ])
    expect(boxes(tidyTemplate(count(5), 5, LAPTOP))).toEqual([
      [0, 0, 4, 12],
      [4, 0, 4, 12],
      [8, 0, 4, 12],
      [0, 12, 6, 12],
      [6, 12, 6, 12],
    ])
    expect(boxes(tidyTemplate(count(3), 1, LAPTOP))).toEqual([
      [0, 0, 12, 24],
      [0, 24, 12, 24],
      [0, 48, 12, 24],
    ])
    expect(boxes(tidyTemplate(count(6), 4, LAPTOP)).slice(3)).toEqual([
      [6, 12, 6, 12],
      [0, 24, 6, 24],
      [6, 24, 6, 24],
    ])
  })

  it('makes screens taller rather than panels smaller than their minimum', () => {
    const short = metrics({ width: 1100, height: 400 })
    const tidied = tidyTemplate(count(5), 4, short)
    expect(tidied.every((p) => p.h >= short.minH)).toBe(true)
    expect(tidied[4]).toMatchObject({ x: 0, y: 2 * short.minH })
  })

  it('spreads a short screen over even rows that fill its width and height', () => {
    expect(boxes(tidyTemplate(count(7), 6, LAPTOP)).slice(6)).toEqual([[0, 24, 12, 24]])
    expect(boxes(tidyTemplate(count(4), 6, LAPTOP))).toEqual([
      [0, 0, 6, 12],
      [6, 0, 6, 12],
      [0, 12, 6, 12],
      [6, 12, 6, 12],
    ])
    expect(boxes(tidyTemplate(count(3), 4, LAPTOP))).toEqual([
      [0, 0, 6, 12],
      [6, 0, 6, 12],
      [0, 12, 12, 12],
    ])
  })

  it('gives a new panel the first free slot, on the next screen once this one is full', () => {
    const full = tidyTemplate(count(3), 3, LAPTOP)
    expect(nextSlot(full, 3, LAPTOP)).toEqual({ x: 0, y: 24, w: 4, h: 24 })
    expect(nextSlot(full.slice(0, 2), 3, LAPTOP)).toEqual({ x: 8, y: 0, w: 4, h: 24 })
    const added = addPanel(full, 'new', LAPTOP, nextSlot(full, 3, LAPTOP))
    expect(boxes(added.panels)).toEqual([...boxes(full), [0, 24, 4, 24]])
  })
})

describe('rows of at most so many across', () => {
  const counts = Array.from({ length: 10 }, (_, k) => k + 1)
  const mixed = (n: number) =>
    Array.from({ length: n }, (_, k) => {
      const id = `p${String(k + 1)}`
      return k % 3 === 1 ? tile(id, [0, k * 4, 4, 4]) : panel(id, [0, k * 4, 4, 4])
    })
  const rowsOf = (panels: readonly Panel[], top: number, height: number) => {
    const onScreen = panels.filter((p) => p.y >= top && p.y < top + height)
    return [...new Set(onScreen.map((p) => p.y))].map((y) => onScreen.filter((p) => p.y === y))
  }

  it('splits n panels into ceil(n / most) rows, the fuller first and never two apart', () => {
    expect(rowSizes(5, 3)).toEqual([3, 2])
    expect(rowSizes(7, 3)).toEqual([3, 2, 2])
    expect(rowSizes(4, 3)).toEqual([2, 2])
    expect(rowSizes(10, 4)).toEqual([4, 3, 3])
    for (const n of counts) {
      for (const most of [1, 2, 3, 4]) {
        const sizes = rowSizes(n, most)
        expect(sizes).toHaveLength(Math.ceil(n / most))
        expect(sizes.reduce((a, b) => a + b, 0)).toBe(n)
        expect(Math.max(...sizes)).toBeLessThanOrEqual(most)
        expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1)
        expect([...sizes].sort((a, b) => b - a)).toEqual(sizes)
      }
    }
  })

  it('fills each row with equal boxes and each screen with its rows, terminals and all', () => {
    for (const perScreen of [1, 2, 3, 4, 5, 6]) {
      for (const n of counts) {
        const tidied = tidyTemplate(mixed(n), perScreen, LAPTOP)
        const ordered = [...tidied].sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y))
        expect(ordered.map((p) => p.i)).toEqual(mixed(n).map((p) => p.i))
        expect(tidied.filter((p) => p.terminal !== undefined)).toHaveLength(Math.floor((n + 1) / 3))
        for (let screen = 0; screen * perScreen < n; screen++) {
          const shown = Math.min(perScreen, n - screen * perScreen)
          const rows = rowsOf(tidied, screen * ROWS, ROWS)
          expect(rows.map((row) => row.length)).toEqual(rowSizes(shown, templateAcross(perScreen)))
          expect(rows.reduce((sum, row) => sum + (row[0]?.h ?? 0), 0)).toBe(ROWS)
          for (const row of rows) {
            expect(new Set(row.map((p) => p.w)).size).toBe(1)
            expect(row.reduce((sum, p) => sum + p.w, 0)).toBe(COLS)
          }
        }
      }
    }
  })

  it('tidies to fit the window in even rows of equal boxes', () => {
    for (const n of counts) {
      const tidied = tidy(mixed(n), WIDE)
      const rows = rowsOf(tidied, 0, Number.POSITIVE_INFINITY)
      const sizes = rows.map((row) => row.length)
      expect(sizes).toEqual(rowSizes(n, sizes[0] ?? 1))
      for (const row of rows) {
        expect(new Set(row.map((p) => p.w)).size).toBe(1)
        expect(row.reduce((sum, p) => sum + p.w, 0)).toBe(COLS)
      }
    }
    const shape = (n: number) => rowsOf(tidy(mixed(n), LAPTOP), 0, Number.POSITIVE_INFINITY).map((row) => row.length)
    expect(shape(7)).toEqual([3, 2, 2])
    expect(shape(5)).toEqual([3, 2])
  })
})

describe('neighbour', () => {
  const grid = [panel('a', [0, 0, 6, 12]), panel('b', [6, 0, 6, 12]), panel('c', [0, 12, 12, 12])]

  it('moves focus to the panel beside, or the nearest one that way', () => {
    expect(neighbour(grid, 'a', 'right')?.i).toBe('b')
    expect(neighbour(grid, 'b', 'down')?.i).toBe('c')
    expect(neighbour(grid, 'c', 'up')?.i).toBe('a')
    expect(neighbour(grid, 'a', 'left')).toBeNull()
    const offset = [panel('a', [0, 0, 4, 6]), panel('b', [8, 8, 4, 6])]
    expect(neighbour(offset, 'a', 'right')?.i).toBe('b')
  })
})

describe('assign, remove and prune', () => {
  const pair = [panel('p1', [0, 0, 6, 12], 'a'), panel('p2', [6, 0, 6, 12], 'b')]

  it('trades agents when the picked one sits in another panel', () => {
    expect(assign(pair, 'p1', 'b').map((p) => p.agent)).toEqual(['b', 'a'])
    expect(assign(pair, 'p2', null).map((p) => p.agent)).toEqual(['a', null])
  })

  it('lets the rest float up after a removal, and empties panels of gone agents', () => {
    const stack = [panel('p1', [0, 0, 12, 6], 'a'), panel('p2', [0, 6, 12, 6], 'b')]
    expect(rects(removePanel(stack, 'p1'))).toEqual({ p2: [0, 0, 12, 6] })
    expect(prune(pair, new Set(['a'])).map((p) => p.agent)).toEqual(['a', null])
    expect(prune(pair, new Set(['a', 'b']))).toBe(pair)
  })
})

describe('terminal tiles', () => {
  const mixed = [panel('p1', [0, 0, 6, 12], 'a'), tile('p2', [6, 0, 6, 12]), panel('p3', [0, 12, 4, 12], null)]

  it('tidies terminals as boxes, keeping each one and its shell', () => {
    for (const tidied of [tidy(mixed, LAPTOP), tidyTemplate(mixed, 1, LAPTOP), tidyTemplate(mixed, 4, LAPTOP)]) {
      expect(tidied).toHaveLength(3)
      expect(tidied.map((p) => p.terminal?.id ?? p.agent)).toEqual(['a', 't-p2', null])
      expect(tidied.every((p) => p.w >= LAPTOP.minW && p.h >= LAPTOP.minH)).toBe(true)
    }
    expect(tidyTemplate(mixed, 2, LAPTOP)[1]).toMatchObject({ x: 6, y: 0, w: 6, h: 24, terminal: { id: 't-p2' } })
  })

  it('adds a terminal panel with no agent, beside the rest', () => {
    const terminal = { id: 't9', name: 'Terminal 2', task: 'a' }
    const added = addPanel(mixed.slice(0, 2), terminal, LAPTOP)
    expect(added.panels.find((p) => p.i === added.id)).toMatchObject({ agent: null, terminal })
    expect(settle(added.panels).find((p) => p.i === added.id)?.terminal).toEqual(terminal)
  })

  it('opens a terminal only in an empty panel, never trades it for an agent, and renames it', () => {
    const terminal = { id: 't9', name: 'Terminal', task: null }
    expect(withTerminal(mixed, 'p3', terminal)[2]?.terminal).toEqual(terminal)
    expect(withTerminal(mixed, 'p1', terminal)).toEqual(mixed)
    expect(assign(mixed, 'p2', 'a')).toEqual(mixed)
    expect(renamedTerminal(mixed, 'p2', '  build  ')[1]?.terminal?.name).toBe('build')
    expect(renamedTerminal(mixed, 'p2', '   ')).toEqual(mixed)
    expect(samePanels(renamedTerminal(mixed, 'p2', 'build'), mixed)).toBe(false)
    expect(
      samePanels(
        mixed.map((p) => ({ ...p })),
        mixed,
      ),
    ).toBe(true)
  })

  it('keeps terminals out of pruning and live streams', () => {
    expect(prune(mixed, new Set())[1]).toBe(mixed[1])
    expect([...livePanels(mixed, { focused: 'p2', recent: [], budget: 3 })]).toEqual(['p1'])
  })
})

describe('livePanels', () => {
  it('streams the focused panel, then the most recently focused, within the budget', () => {
    const panels = ['a', 'b', 'c', 'd'].map((agent, k) => panel(`p${String(k)}`, [0, k, 12, 1], agent))
    const live = livePanels([...panels, panel('p9', [0, 9, 12, 1], null)], {
      focused: 'p3',
      recent: ['b', 'c'],
      budget: 3,
    })
    expect([...live].sort((a, b) => a.localeCompare(b))).toEqual(['p1', 'p2', 'p3'])
    expect(streamBudget('http/1.1')).toBe(3)
    expect(streamBudget('h2')).toBe(Number.POSITIVE_INFINITY)
  })
})
