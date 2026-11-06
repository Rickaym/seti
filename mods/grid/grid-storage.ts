import { isRecord, TERMINAL_NAME_MAX, type TerminalRef } from '@seti/mod-api'
import { COLS, ROWS, settle, type Panel } from './grid-layout'

const isUnit = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

/** A stored panel's terminal, or undefined when it has none this version can show. */
function readTerminal(value: unknown): TerminalRef | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const { id, name, task } = value
  if (typeof id !== 'string' || id === '' || typeof name !== 'string' || name.trim() === '') {
    return undefined
  }
  return { id, name: name.trim().slice(0, TERMINAL_NAME_MAX), task: typeof task === 'string' ? task : null }
}

/** One stored panel, or null when it is not one this version wrote. */
function readPanel(entry: unknown): Panel | null {
  if (typeof entry !== 'object' || entry === null) {
    return null
  }
  const { i, agent, terminal, x, y, w, h } = entry as Record<string, unknown>
  if (typeof i !== 'string' || (agent !== null && typeof agent !== 'string')) {
    return null
  }
  if (!isUnit(x, 0, COLS - 1) || !isUnit(y, 0, 10_000) || !isUnit(w, 1, COLS) || !isUnit(h, 1, 10_000)) {
    return null
  }
  const rect = { x: Math.min(x, COLS - w), y, w, h }
  const shell = agent === null ? readTerminal(terminal) : undefined
  return shell === undefined ? { i, agent, ...rect } : { i, agent, terminal: shell, ...rect }
}

/** The panel with what it shows taken out, when another panel already shows that. */
function emptied({ i, x, y, w, h }: Panel): Panel {
  return { i, agent: null, x, y, w, h }
}

/**
 * Panels read back from storage, settled and without duplicates, or null when unreadable. A
 * second panel for one agent or one terminal is left empty.
 */
export function parsePanels(value: unknown): Panel[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const read = (value as unknown[]).map(readPanel)
  if (read.includes(null)) {
    return null
  }
  const ids = new Set<string>()
  const shown = new Set<string>()
  const panels: Panel[] = []
  for (const panel of read) {
    if (panel === null || ids.has(panel.i)) {
      continue
    }
    ids.add(panel.i)
    const key = panel.agent ?? (panel.terminal === undefined ? null : `terminal:${panel.terminal.id}`)
    if (key !== null && shown.has(key)) {
      panels.push(emptied(panel))
      continue
    }
    if (key !== null) {
      shown.add(key)
    }
    panels.push(panel)
  }
  return settle(panels)
}

/** Track edges in units for shares summing to 1, each track at least one unit wide. */
function edges(parts: readonly number[], total: number): number[] {
  const out = [0]
  let sum = 0
  parts.forEach((share, index) => {
    sum += share
    const left = parts.length - index - 1
    const previous = out[index] ?? 0
    out.push(clamp(Math.round(sum * total), previous + 1, total - left))
  })
  return out
}

/** Shares as stored, scaled to sum to 1, or even ones when they are not usable. */
function sharesOf(value: unknown, n: number): number[] {
  const usable =
    Array.isArray(value) &&
    value.length === n &&
    value.every((share) => typeof share === 'number' && Number.isFinite(share) && share > 0)
  const raw = usable ? (value as number[]) : Array.from({ length: n }, () => 1)
  const sum = raw.reduce((a, b) => a + b, 0)
  return raw.map((share) => share / sum)
}

/** Panels from the rows-and-columns grid: placed agents keep their cell's place and size. */
export function migrateCells(
  value: unknown,
  focusedIndex: unknown,
): { panels: Panel[]; focused: string | null } | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { rows, cols, colSizes, rowSizes, cells } = value as Record<string, unknown>
  if (!isUnit(rows, 1, 4) || !isUnit(cols, 1, 4) || !Array.isArray(cells) || cells.length !== rows * cols) {
    return null
  }
  const xs = edges(sharesOf(colSizes, cols), COLS)
  const ys = edges(sharesOf(rowSizes, rows), ROWS)
  const span = (bounds: readonly number[], track: number) => {
    const start = bounds[track] ?? 0
    return { start, size: (bounds[track + 1] ?? start + 1) - start }
  }
  const seen = new Set<string>()
  const panels: Panel[] = []
  let focused: string | null = null
  for (const [index, cell] of (cells as unknown[]).entries()) {
    if (typeof cell !== 'string' || seen.has(cell)) {
      continue
    }
    seen.add(cell)
    const across = span(xs, index % cols)
    const down = span(ys, Math.floor(index / cols))
    const i = `p${String(panels.length + 1)}`
    panels.push({ i, agent: cell, x: across.start, y: down.start, w: across.size, h: down.size })
    if (index === focusedIndex) {
      focused = i
    }
  }
  return { panels: settle(panels), focused: focused ?? panels[0]?.i ?? null }
}
