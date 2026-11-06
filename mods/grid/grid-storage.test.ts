import { describe, expect, it } from 'vitest'
import type { Panel } from './grid-layout'
import { migrateCells, parsePanels } from './grid-storage'

type Box = [x: number, y: number, w: number, h: number]

const panel = (i: string, [x, y, w, h]: Box, agent: string | null = i): Panel => ({ i, agent, x, y, w, h })

describe('parsePanels', () => {
  it('reads stored panels back, settled, without duplicates', () => {
    const stored = [panel('p1', [0, 3, 6, 12], 'a'), panel('p1', [6, 0, 6, 12], 'b'), panel('p2', [11, 0, 4, 12], 'a')]
    expect(parsePanels(stored)).toEqual([panel('p1', [0, 0, 6, 12], 'a'), panel('p2', [8, 0, 4, 12], null)])
  })

  it('reads terminal tiles back, leaving a second tile of one shell empty', () => {
    const terminal = { id: 't1', name: 'Terminal', task: null }
    const stored = [
      { ...panel('p1', [0, 0, 6, 12], null), terminal },
      { ...panel('p2', [6, 0, 6, 12], null), terminal: { ...terminal, task: 'a', name: ' build ' } },
      { ...panel('p3', [0, 12, 6, 12], null), terminal: { ...terminal, id: 't3', task: 'a' } },
      { ...panel('p4', [6, 12, 6, 12], 'b'), terminal: { ...terminal, id: 't4' } },
      { ...panel('p5', [0, 24, 6, 12], null), terminal: { id: '', name: 'Bad' } },
    ]
    expect(parsePanels(JSON.parse(JSON.stringify(stored)))).toEqual([
      { ...panel('p1', [0, 0, 6, 12], null), terminal },
      panel('p2', [6, 0, 6, 12], null),
      { ...panel('p3', [0, 12, 6, 12], null), terminal: { ...terminal, id: 't3', task: 'a' } },
      panel('p4', [6, 12, 6, 12], 'b'),
      panel('p5', [0, 24, 6, 12], null),
    ])
  })

  it('refuses values this version did not write', () => {
    expect(parsePanels({})).toBeNull()
    expect(parsePanels([{ i: 'p1', agent: 'a', x: 0, y: 0, w: 0, h: 4 }])).toBeNull()
    expect(parsePanels([{ i: 1, agent: 'a', x: 0, y: 0, w: 4, h: 4 }])).toBeNull()
  })
})

describe('migrateCells', () => {
  it('keeps each placed agent in its cell, sized from the dragged shares', () => {
    const old = { rows: 2, cols: 2, colSizes: [0.25, 0.75], rowSizes: [0.5, 0.5], cells: ['a', null, 'b', 'c'] }
    expect(migrateCells(old, 3)).toEqual({
      panels: [panel('p1', [0, 0, 3, 12], 'a'), panel('p2', [0, 12, 3, 12], 'b'), panel('p3', [3, 0, 9, 12], 'c')],
      focused: 'p3',
    })
  })

  it('lets agents float up from empty rows and focuses the first when the focused cell was empty', () => {
    const old = { rows: 3, cols: 1, colSizes: [1], rowSizes: [0.2, 0.3, 0.5], cells: [null, 'a', 'a'] }
    expect(migrateCells(old, 0)).toEqual({ panels: [panel('p1', [0, 0, 12, 7], 'a')], focused: 'p1' })
  })

  it('refuses shapes the old grid never stored', () => {
    expect(migrateCells({ rows: 9, cols: 1, cells: [] }, 0)).toBeNull()
    expect(migrateCells(null, 0)).toBeNull()
  })
})
