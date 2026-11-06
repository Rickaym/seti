import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { cellKey, type Grid, type Merge } from './grid'
import { useKit } from './kit'

const ROW_HEIGHT = 28
const OVERSCAN = 8
const WIDTH_SAMPLE = 200
const MIN_CH = 4
const MAX_CH = 40
/** A merge bigger than this keeps its top-left value only, so a huge one costs no memory. */
const MERGE_AREA_MAX = 10_000
const NUMERIC = /^[-+]?[\d,.\s]+%?$/

export interface CellRef {
  row: number
  col: number
}

interface SheetTableProps {
  grid: Grid
  /** Row indexes to show in order, the header row left out. */
  visible: readonly number[]
  names: readonly string[]
  selected: CellRef | null
  onSelect: (cell: CellRef) => void
  onCopy: () => void
  label: string
}

/** Character widths of each column from the names and the first rows, within sensible bounds. */
function columnWidths(grid: Grid, names: readonly string[]): number[] {
  const widths = Array.from({ length: grid.columns }, (_, c) => Math.max(MIN_CH, (names[c] ?? '').length + 1))
  for (const row of grid.rows.slice(0, WIDTH_SAMPLE)) {
    row.forEach((cell, c) => {
      widths[c] = Math.min(MAX_CH, Math.max(widths[c] ?? MIN_CH, cell.length + 1))
    })
  }
  return widths
}

interface MergeLayout {
  starts: Map<string, Merge>
  /** Cells under a merge but not its top-left one. */
  covered: Map<string, Merge>
}

function mergeLayout(merges: readonly Merge[]): MergeLayout {
  const starts = new Map<string, Merge>()
  const covered = new Map<string, Merge>()
  for (const merge of merges) {
    starts.set(cellKey(merge.row, merge.col), merge)
    if (merge.rows * merge.cols > MERGE_AREA_MAX) {
      continue
    }
    for (let r = merge.row; r < merge.row + merge.rows; r++) {
      for (let c = merge.col; c < merge.col + merge.cols; c++) {
        if (r !== merge.row || c !== merge.col) {
          covered.set(cellKey(r, c), merge)
        }
      }
    }
  }
  return { starts, covered }
}

const CELL = 'truncate border-r border-b border-border px-2 leading-7'

/** How one cell draws: hidden under a merge to its left or above, or spanning columns. */
function placement(layout: MergeLayout, row: number, col: number): { span: number; under: boolean } | null {
  const key = cellKey(row, col)
  const under = layout.covered.get(key)
  if (under === undefined) {
    return { span: layout.starts.get(key)?.cols ?? 1, under: false }
  }
  return under.row === row || col !== under.col ? null : { span: under.cols, under: true }
}

interface CellProps {
  value: string
  cell: string
  span: number
  under: boolean
  formula: string | undefined
  width: number
  selected: boolean
}

function Cell({ value, cell, span, under, formula, width, selected }: CellProps) {
  const { cn } = useKit()
  const long = value.length >= width
  const title = formula === undefined ? undefined : `${value}\n${formula}`
  return (
    <div
      role="gridcell"
      aria-selected={selected}
      data-cell={cell}
      title={title ?? (long ? value : undefined)}
      style={span > 1 ? { gridColumn: `span ${String(span)}` } : undefined}
      className={cn(
        CELL,
        'relative cursor-cell',
        NUMERIC.test(value) && 'text-right tabular-nums',
        under && 'bg-muted/40',
        formula !== undefined && 'before:absolute before:top-0 before:right-0 before:size-1.5 before:bg-primary/60',
        selected && 'outline-2 -outline-offset-2 outline-primary',
      )}
    >
      {value}
    </div>
  )
}

interface RowProps {
  grid: Grid
  row: number
  position: number
  layout: MergeLayout
  selected: CellRef | null
  widths: readonly number[]
  template: string
}

function Row({ grid, row, position, layout, selected, widths, template }: RowProps) {
  const { cn } = useKit()
  const values = grid.rows[row] ?? []
  const cells = []
  for (let c = 0; c < grid.columns; c++) {
    const place = placement(layout, row, c)
    if (place !== null) {
      const key = cellKey(row, c)
      cells.push(
        <Cell
          key={c}
          cell={key}
          value={place.under ? '' : (values[c] ?? '')}
          span={place.span}
          under={place.under}
          formula={grid.formulas.get(key)}
          width={widths[c] ?? MAX_CH}
          selected={selected?.row === row && selected.col === c}
        />,
      )
    }
  }
  return (
    <div
      role="row"
      aria-rowindex={position + 2}
      className="grid h-7 hover:bg-muted/30"
      style={{ gridTemplateColumns: template }}
    >
      <div
        role="rowheader"
        className={cn(CELL, 'sticky left-0 z-10 bg-muted text-right text-muted-foreground tabular-nums')}
      >
        {row + 1}
      </div>
      {cells}
    </div>
  )
}

function useViewport(scroller: HTMLDivElement | null) {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    if (scroller === null) {
      return undefined
    }
    const observer = new ResizeObserver(() => {
      setHeight(scroller.clientHeight)
    })
    observer.observe(scroller)
    return () => {
      observer.disconnect()
    }
  }, [scroller])
  return height
}

/** Moves the selection with the arrow keys over the rows shown; null when the key does not. */
function stepped(key: string, selected: CellRef, visible: readonly number[], columns: number): CellRef | null {
  const position = visible.indexOf(selected.row)
  const moves: Record<string, CellRef> = {
    ArrowUp: { row: visible[Math.max(0, position - 1)] ?? selected.row, col: selected.col },
    ArrowDown: { row: visible[Math.min(visible.length - 1, position + 1)] ?? selected.row, col: selected.col },
    ArrowLeft: { row: selected.row, col: Math.max(0, selected.col - 1) },
    ArrowRight: { row: selected.row, col: Math.min(columns - 1, selected.col + 1) },
  }
  return moves[key] ?? null
}

/** A table of any length: only the rows in view are drawn, under a sticky header and row numbers. */
export function SheetTable({ grid, visible, names, selected, onSelect, onCopy, label }: SheetTableProps) {
  const { cn } = useKit()
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const keyed = useRef(false)
  const viewport = useViewport(scroller)
  const widths = useMemo(() => columnWidths(grid, names), [grid, names])
  const layout = useMemo(() => mergeLayout(grid.merges), [grid.merges])
  const numberWidth = `calc(${String(String(grid.rows.length).length + 1)}ch + 1rem)`
  const template = [numberWidth, ...widths.map((w) => `calc(${String(w)}ch + 1rem)`)].join(' ')
  const shownTop = Math.min(scrollTop, Math.max(0, visible.length * ROW_HEIGHT - viewport))
  const first = Math.max(0, Math.floor(shownTop / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(visible.length, Math.ceil((shownTop + viewport) / ROW_HEIGHT) + OVERSCAN)

  useEffect(() => {
    scroller?.scrollTo({ top: 0 })
  }, [scroller, visible])

  useEffect(() => {
    if (selected === null || !keyed.current || scroller === null) {
      return
    }
    keyed.current = false
    const position = visible.indexOf(selected.row)
    const top = position * ROW_HEIGHT
    const room = scroller.clientHeight - ROW_HEIGHT
    if (top < scroller.scrollTop) {
      scroller.scrollTo({ top })
    } else if (top + ROW_HEIGHT > scroller.scrollTop + room) {
      scroller.scrollTo({ top: top + ROW_HEIGHT - room })
    }
    requestAnimationFrame(() => {
      scroller
        .querySelector(`[data-cell="${cellKey(selected.row, selected.col)}"]`)
        ?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
    })
  }, [selected, scroller, visible])

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-cell]')
    const [row, col] = (cell?.dataset.cell ?? '').split(':').map(Number)
    if (row !== undefined && col !== undefined && !Number.isNaN(row) && !Number.isNaN(col)) {
      onSelect({ row, col })
    }
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (
      (e.ctrlKey || e.metaKey) &&
      e.key.toLowerCase() === 'c' &&
      selected !== null &&
      window.getSelection()?.isCollapsed !== false
    ) {
      e.preventDefault()
      onCopy()
      return
    }
    const next = selected === null ? null : stepped(e.key, selected, visible, grid.columns)
    if (next !== null) {
      e.preventDefault()
      keyed.current = true
      onSelect(next)
    }
  }

  return (
    <div
      ref={setScroller}
      role="grid"
      aria-label={label}
      aria-rowcount={visible.length + 1}
      aria-colcount={grid.columns + 1}
      tabIndex={0}
      onScroll={(e) => {
        setScrollTop(e.currentTarget.scrollTop)
      }}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className="min-h-0 flex-1 overflow-auto text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
      style={{ scrollPaddingTop: ROW_HEIGHT, scrollPaddingLeft: numberWidth }}
    >
      <div className="w-max min-w-full">
        <div
          role="row"
          aria-rowindex={1}
          className="sticky top-0 z-20 grid h-7 bg-muted font-medium"
          style={{ gridTemplateColumns: template }}
        >
          <div role="columnheader" className={cn(CELL, 'sticky left-0 z-10 bg-muted')} aria-label="Row" />
          {names.map((name, c) => (
            <div key={c} role="columnheader" title={name} className={cn(CELL, 'bg-muted')}>
              {name}
            </div>
          ))}
        </div>
        <div style={{ height: visible.length * ROW_HEIGHT, paddingTop: first * ROW_HEIGHT }}>
          {visible.slice(first, last).map((row, i) => (
            <Row
              key={row}
              grid={grid}
              row={row}
              position={first + i}
              layout={layout}
              selected={selected}
              widths={widths}
              template={template}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
