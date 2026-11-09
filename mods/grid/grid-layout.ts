import { GRID_COLS, TERMINAL_NAME_MAX, type TerminalRef } from '@seti/mod-api'
import { verticalCompactor, type LayoutItem } from 'react-grid-layout/core'

export const COLS = GRID_COLS
/** Rows in one screen of grid, so a layout that fits one window fits the next one too. */
export const ROWS = 24
/** Pixels between panels and around the grid's edge. */
export const GAP = 8

/** Below these a panel's header and composer stop fitting. */
const MIN_PANEL_WIDTH = 300
const MIN_PANEL_HEIGHT = 240

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** One panel's place in the grid, in columns and rows: an agent, a terminal, or empty. */
export interface Panel extends Rect {
  i: string
  agent: string | null
  /** The shell the panel shows instead of an agent; its agent is then null. */
  terminal?: TerminalRef
}

export interface Room {
  width: number
  height: number
}

/** A grid unit in pixels, and the fewest units a panel may span. */
export interface Metrics {
  colWidth: number
  rowHeight: number
  minW: number
  minH: number
}

export type Direction = 'left' | 'right' | 'up' | 'down'

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

/** Units of `unit` pixels, with gaps between them, that cover `px` pixels. */
const spanFor = (px: number, unit: number) => Math.ceil((px + GAP) / (unit + GAP))

export function metrics({ width, height }: Room): Metrics {
  const colWidth = Math.max(1, (width - GAP * (COLS + 1)) / COLS)
  const rowHeight = Math.max(1, (height - GAP * (ROWS + 1)) / ROWS)
  return {
    colWidth,
    rowHeight,
    minW: clamp(spanFor(MIN_PANEL_WIDTH, colWidth), 1, COLS),
    minH: Math.max(1, spanFor(MIN_PANEL_HEIGHT, rowHeight)),
  }
}

/** A span of `units` grid units in pixels. */
const spanPx = (units: number, unit: number) => units * unit + Math.max(0, units - 1) * GAP

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h

const sameTerminal = (a: TerminalRef | undefined, b: TerminalRef | undefined) =>
  a?.id === b?.id && a?.name === b?.name && a?.task === b?.task

export const samePanels = (a: readonly Panel[], b: readonly Panel[]) =>
  a.length === b.length &&
  a.every((panel, index) => {
    const other = b[index]
    return (
      other?.i === panel.i &&
      other.agent === panel.agent &&
      sameTerminal(other.terminal, panel.terminal) &&
      sameRect(panel, other)
    )
  })

/** The bottom edge of the lowest panel. */
const bottom = (panels: readonly Rect[]) => panels.reduce((max, p) => Math.max(max, p.y + p.h), 0)

const byPosition = (a: Rect, b: Rect) => (a.y === b.y ? a.x - b.x : a.y - b.y)

/** Panels in reading order: top to bottom, then left to right. */
const readingOrder = <T extends Rect>(panels: readonly T[]): T[] => [...panels].sort(byPosition)

/** Floats panels up until they rest on another, so rows form from moves; `pinned` holds still. */
export function settle(panels: readonly Panel[], pinned: string | null = null): Panel[] {
  const items: LayoutItem[] = panels.map(({ i, x, y, w, h }) => ({ i, x, y, w, h, static: i === pinned }))
  let settled = verticalCompactor.compact(items, COLS)
  if (pinned !== null) {
    settled = verticalCompactor.compact(
      settled.map((item) => ({ ...item, static: false })),
      COLS,
    )
  }
  const byId = new Map(settled.map((item) => [item.i, item]))
  return panels.map((panel) => {
    const item = byId.get(panel.i)
    return item === undefined ? panel : { ...panel, x: item.x, y: item.y, w: item.w, h: item.h }
  })
}

/** Panels as this window shows them: at least minimum size, inside the columns, never overlapping. */
export function fit(panels: readonly Panel[], { minW, minH }: Pick<Metrics, 'minW' | 'minH'>): Panel[] {
  const sized = panels.map((panel) => {
    const w = clamp(Math.max(panel.w, minW), 1, COLS)
    return { ...panel, w, h: Math.max(panel.h, minH), x: clamp(panel.x, 0, COLS - w) }
  })
  return settle(sized)
}

/** Copies each panel's place from `layout`, as the grid reports it after a drag. */
export function withRects(panels: readonly Panel[], layout: readonly (Rect & { i: string })[]): Panel[] {
  const byId = new Map(layout.map((item) => [item.i, item]))
  return panels.map((panel) => {
    const item = byId.get(panel.i)
    return item === undefined ? panel : { ...panel, x: item.x, y: item.y, w: item.w, h: item.h }
  })
}

const HORIZONTAL: Record<Direction, boolean> = { left: true, right: true, up: false, down: false }

/** How far `b` lies past `a` in `direction`, or null when it does not lie that way. */
function gapTo(a: Rect, b: Rect, direction: Direction): number | null {
  const gaps: Record<Direction, number> = {
    right: b.x - (a.x + a.w),
    left: a.x - (b.x + b.w),
    down: b.y - (a.y + a.h),
    up: a.y - (b.y + b.h),
  }
  const gap = gaps[direction]
  return gap >= 0 ? gap : null
}

/** The rows (left, right) or columns (up, down) that `a` and `b` share. */
function sharedSpan(a: Rect, b: Rect, direction: Direction): number {
  return HORIZONTAL[direction]
    ? Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
    : Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
}

/** The panel beside `id` in `direction` that shares rows or columns with it, nearest first. */
function adjacent(panels: readonly Panel[], id: string, direction: Direction): Panel | null {
  const from = panels.find((panel) => panel.i === id)
  if (from === undefined) {
    return null
  }
  const ranked = panels.flatMap((panel) => {
    const gap = panel.i === id ? null : gapTo(from, panel, direction)
    const shared = sharedSpan(from, panel, direction)
    return gap === null || shared <= 0 ? [] : [{ panel, gap, shared }]
  })
  ranked.sort((a, b) => {
    if (a.gap !== b.gap) {
      return a.gap - b.gap
    }
    return a.shared === b.shared ? byPosition(a.panel, b.panel) : b.shared - a.shared
  })
  return ranked[0]?.panel ?? null
}

function replaced(panels: readonly Panel[], changes: ReadonlyMap<string, Partial<Rect>>): Panel[] {
  return panels.map((panel) => {
    const change = changes.get(panel.i)
    return change === undefined ? panel : { ...panel, ...change }
  })
}

/** Moves a panel one place: it trades places with the panel beside it, or slides to the edge. */
export function movePanel(panels: readonly Panel[], id: string, direction: Direction): Panel[] {
  const panel = panels.find((p) => p.i === id)
  if (panel === undefined) {
    return [...panels]
  }
  const other = adjacent(panels, id, direction)
  const changes = new Map<string, Partial<Rect>>()
  if (HORIZONTAL[direction]) {
    if (other === null) {
      changes.set(id, { x: direction === 'right' ? COLS - panel.w : 0 })
    } else if (direction === 'right') {
      changes.set(id, { x: clamp(other.x + other.w - panel.w, 0, COLS - panel.w) })
      changes.set(other.i, { x: clamp(panel.x, 0, COLS - other.w) })
    } else {
      changes.set(id, { x: other.x })
      changes.set(other.i, { x: clamp(panel.x + panel.w - other.w, 0, COLS - other.w) })
    }
  } else if (other !== null) {
    if (direction === 'up') {
      changes.set(id, { y: other.y })
      changes.set(other.i, { y: other.y + panel.h })
    } else {
      changes.set(id, { y: panel.y + other.h })
      changes.set(other.i, { y: panel.y })
    }
  }
  return settle(replaced(panels, changes), id)
}

/** One column wider: to the right, or to the left at the right edge. */
function wider(panel: Rect): Partial<Rect> {
  if (panel.w >= COLS) {
    return {}
  }
  return panel.x + panel.w < COLS ? { w: panel.w + 1 } : { x: panel.x - 1, w: panel.w + 1 }
}

/** Grows or shrinks a panel by one unit: right and down grow it, left and up shrink it. */
export function resizePanel(
  panels: readonly Panel[],
  id: string,
  direction: Direction,
  { minW, minH }: Pick<Metrics, 'minW' | 'minH'>,
): Panel[] {
  const panel = panels.find((p) => p.i === id)
  if (panel === undefined) {
    return [...panels]
  }
  const sizes: Record<Direction, Partial<Rect>> = {
    right: wider(panel),
    left: panel.w > minW ? { w: panel.w - 1 } : {},
    down: { h: panel.h + 1 },
    up: panel.h > minH ? { h: panel.h - 1 } : {},
  }
  return settle(replaced(panels, new Map([[id, sizes[direction]]])), id)
}

/** `total` units in `parts` spans as even as whole units allow, the larger ones first. */
export function evenSpans(total: number, parts: number): number[] {
  const base = Math.floor(total / parts)
  const extra = total - base * parts
  return Array.from({ length: parts }, (_, index) => base + (index < extra ? 1 : 0))
}

const offsets = (spans: readonly number[]) => spans.map((_, index) => spans.slice(0, index).reduce((a, b) => a + b, 0))

/** The free rectangle whose top left is (x, y), grown as wide and then as tall as it goes. */
function holeAt(x: number, y: number, taken: (x: number, y: number) => boolean): Rect {
  let w = 1
  while (x + w < COLS && !taken(x + w, y)) {
    w++
  }
  const rowFree = (row: number) => Array.from({ length: w }, (_, dx) => taken(x + dx, row)).every((t) => !t)
  let h = 1
  while (y + h < ROWS && rowFree(y + h)) {
    h++
  }
  return { x, y, w, h }
}

/** The first hole on screen big enough for a panel. */
export function freeSpot(panels: readonly Rect[], { minW, minH }: Pick<Metrics, 'minW' | 'minH'>): Rect | null {
  const taken = (x: number, y: number) => panels.some((p) => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h)
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const hole = taken(x, y) ? null : holeAt(x, y, taken)
      if (hole !== null && hole.w >= minW && hole.h >= minH) {
        return hole
      }
    }
  }
  return null
}

/** Halves the largest panel that stays usable as two, and returns the freed half. */
function splitLargest(panels: readonly Panel[], m: Metrics): { panels: Panel[]; spot: Rect } | null {
  const px = (p: Rect) => ({ width: spanPx(p.w, m.colWidth), height: spanPx(p.h, m.rowHeight) })
  const bySize = readingOrder(panels).sort((a, b) => px(b).width * px(b).height - px(a).width * px(a).height)
  for (const panel of bySize) {
    const { width, height } = px(panel)
    const across = { keep: panel.w - Math.floor(panel.w / 2), give: Math.floor(panel.w / 2) }
    const down = { keep: panel.h - Math.floor(panel.h / 2), give: Math.floor(panel.h / 2) }
    const splits = [
      {
        ok: across.give >= m.minW,
        keep: { w: across.keep },
        spot: { x: panel.x + across.keep, y: panel.y, w: across.give, h: panel.h },
      },
      {
        ok: down.give >= m.minH,
        keep: { h: down.keep },
        spot: { x: panel.x, y: panel.y + down.keep, w: panel.w, h: down.give },
      },
    ]
    const ordered = width >= height ? splits : [...splits].reverse()
    const split = ordered.find((option) => option.ok)
    if (split !== undefined) {
      return { panels: replaced(panels, new Map([[panel.i, split.keep]])), spot: split.spot }
    }
  }
  return null
}

function nextPanelId(panels: readonly Panel[]): string {
  const taken = panels.map((panel) => Number(/^p(\d+)$/u.exec(panel.i)?.[1] ?? 0))
  return `p${String(Math.max(0, ...taken) + 1)}`
}

/**
 * Adds a panel for an agent, a terminal, or neither when `shows` is null: at `at`, else in a hole
 * on screen, else in half the largest panel, else below.
 */
export function addPanel(
  panels: readonly Panel[],
  shows: string | TerminalRef | null,
  m: Metrics,
  at: Rect | null = null,
): { panels: Panel[]; id: string } {
  const id = nextPanelId(panels)
  const panel = (rect: Rect): Panel =>
    typeof shows === 'object' && shows !== null
      ? { i: id, agent: null, terminal: shows, ...rect }
      : { i: id, agent: shows, ...rect }
  if (at !== null) {
    const w = clamp(Math.max(at.w, m.minW), 1, COLS)
    const spot = { x: clamp(at.x, 0, COLS - w), y: Math.max(0, at.y), w, h: Math.max(at.h, m.minH) }
    return { panels: settle([...panels, panel(spot)], id), id }
  }
  const hole = freeSpot(panels, m)
  if (hole !== null) {
    return { panels: settle([...panels, panel(hole)], id), id }
  }
  const split = splitLargest(panels, m)
  if (split !== null) {
    return { panels: settle([...split.panels, panel(split.spot)], id), id }
  }
  const w = Math.max(m.minW, COLS / 2)
  const spot = { x: 0, y: bottom(panels), w, h: Math.max(m.minH, ROWS / 2) }
  return { panels: settle([...panels, panel(spot)]), id }
}

/** Removes a panel and lets the rest float up into its place. */
export const removePanel = (panels: readonly Panel[], id: string): Panel[] =>
  settle(panels.filter((panel) => panel.i !== id))

/** Puts `agent` in panel `id`; when it sits in another panel the two trade agents. */
export function assign(panels: readonly Panel[], id: string, agent: string | null): Panel[] {
  const target = panels.find((panel) => panel.i === id)
  if (target === undefined || target.agent === agent || target.terminal !== undefined) {
    return [...panels]
  }
  return panels.map((panel) => {
    if (panel.i === id) {
      return { ...panel, agent }
    }
    return agent !== null && panel.agent === agent ? { ...panel, agent: target.agent } : panel
  })
}

/** Puts `terminal` in panel `id`, which must be empty: no agent and no other terminal. */
export function withTerminal(panels: readonly Panel[], id: string, terminal: TerminalRef): Panel[] {
  return panels.map((panel) =>
    panel.i === id && panel.agent === null && panel.terminal === undefined ? { ...panel, terminal } : panel,
  )
}

/** Renames the terminal in panel `id`; a blank name keeps the old one. */
export function renamedTerminal(panels: readonly Panel[], id: string, name: string): Panel[] {
  const next = name.trim().slice(0, TERMINAL_NAME_MAX)
  return panels.map((panel) =>
    panel.i === id && panel.terminal !== undefined && next !== ''
      ? { ...panel, terminal: { ...panel.terminal, name: next } }
      : panel,
  )
}

/** Empties the panels of agents that are gone, such as archived or deleted ones. */
export function prune(panels: readonly Panel[], live: ReadonlySet<string>): readonly Panel[] {
  if (panels.every((panel) => panel.agent === null || live.has(panel.agent))) {
    return panels
  }
  return panels.map((panel) => (panel.agent !== null && !live.has(panel.agent) ? { ...panel, agent: null } : panel))
}

/** `count` panels in rows of at most `most` across, as even as can be, the fuller rows first. */
export function rowSizes(count: number, most: number): number[] {
  return count <= 0 ? [] : evenSpans(count, Math.ceil(count / Math.max(1, most)))
}

/** Rows of `sizes` panels that split one screen's height, each row's panels its whole width. */
function rowSlots(sizes: readonly number[], { minW, minH }: Pick<Metrics, 'minW' | 'minH'>): Rect[] {
  const heights = evenSpans(ROWS, sizes.length).map((h) => Math.max(h, minH))
  const tops = offsets(heights)
  return sizes.flatMap((across, row) => {
    const spans = evenSpans(COLS, across)
    const lefts = offsets(spans)
    return spans.map((span, col) => {
      const w = clamp(Math.max(span, minW), 1, COLS)
      return { x: clamp(lefts[col] ?? 0, 0, COLS - w), y: tops[row] ?? 0, w, h: heights[row] ?? minH }
    })
  })
}

/** Each panel's slot, by its place in `ordered`, lowered by `top` rows. */
const slotted = (ordered: readonly Panel[], slots: readonly Rect[], top = 0) =>
  new Map(
    ordered.flatMap((panel, index) => {
      const slot = slots[index]
      return slot === undefined ? [] : [[panel.i, { ...slot, y: slot.y + top }] as const]
    }),
  )

/** Rows whose panels all split the columns evenly, so every panel in a row is as wide as the next. */
const evenAcross = (sizes: readonly number[]) => sizes.every((across) => COLS % across === 0)

/** Panels laid out evenly to fit the window, in their reading order, in rows as even as can be. */
export function tidy(panels: readonly Panel[], m: Metrics): Panel[] {
  const n = panels.length
  if (n === 0) {
    return []
  }
  let best = { sizes: rowSizes(n, 1), score: Number.POSITIVE_INFINITY }
  for (let most = 1; most <= Math.min(n, COLS); most++) {
    const sizes = rowSizes(n, most)
    const across = sizes[0] ?? 1
    const rows = sizes.length
    if (!evenAcross(sizes) || COLS / across < m.minW) {
      continue
    }
    const fits = rows <= ROWS && Math.min(...evenSpans(ROWS, rows)) >= m.minH
    const aspect = spanPx(COLS / across, m.colWidth) / spanPx(ROWS / rows, m.rowHeight)
    const score = (fits ? 0 : 100) + (across * rows - n) * 0.5 + Math.abs(Math.log(aspect))
    if (score < best.score) {
      best = { sizes, score }
    }
  }
  return settle(replaced(panels, slotted(readingOrder(panels), rowSlots(best.sizes, m))))
}

/** Each template's rows, as the panels across each, by how many panels one screen holds. */
const TEMPLATE_ROWS: readonly (readonly number[])[] = [[1], [2], [3], [2, 2], [3, 2], [3, 3]]

/** The templates on offer, by the most panels one screen holds. */
export const PER_SCREEN = TEMPLATE_ROWS.map((_, index) => index + 1)

/** Panels across each row of the template that fits `perScreen` panels in one screen. */
export const templateRows = (perScreen: number): readonly number[] => TEMPLATE_ROWS[perScreen - 1] ?? [1]

/** The most panels across one row of a template. */
export const templateAcross = (perScreen: number): number => Math.max(...templateRows(perScreen))

/** One full screen's slots under a template, in reading order, each at least the minimum size. */
const screenSlots = (perScreen: number, m: Pick<Metrics, 'minW' | 'minH'>): Rect[] =>
  rowSlots(templateRows(perScreen), m)

/** Rows in one screen of a template: a window's height, or more when panels cannot shrink to fit. */
export const screenRows = (perScreen: number, m: Pick<Metrics, 'minW' | 'minH'>): number =>
  bottom(screenSlots(perScreen, m))

/** The template's slots from the top, each screen's under the one before. */
function* templateSlots(perScreen: number, m: Pick<Metrics, 'minW' | 'minH'>): Generator<Rect, never> {
  const slots = screenSlots(perScreen, m)
  const height = bottom(slots)
  for (let screen = 0; ; screen++) {
    for (const slot of slots) {
      yield { ...slot, y: slot.y + screen * height }
    }
  }
}

/** Panels in reading order, up to `perScreen` a screen; a short screen fills itself in even rows. */
export function tidyTemplate(panels: readonly Panel[], perScreen: number, m: Metrics): Panel[] {
  const ordered = readingOrder(panels)
  const height = screenRows(perScreen, m)
  const placed = new Map<string, Rect>()
  for (let first = 0; first < ordered.length; first += perScreen) {
    const screen = ordered.slice(first, first + perScreen)
    const slots = rowSlots(rowSizes(screen.length, templateAcross(perScreen)), m)
    for (const [id, slot] of slotted(screen, slots, (first / perScreen) * height)) {
      placed.set(id, slot)
    }
  }
  return settle(replaced(panels, placed))
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** The template's first slot that no panel covers, a screen further down when these are full. */
export function nextSlot(panels: readonly Rect[], perScreen: number, m: Metrics): Rect {
  const slots = templateSlots(perScreen, m)
  for (;;) {
    const slot = slots.next().value
    if (!panels.some((panel) => overlaps(panel, slot))) {
      return slot
    }
  }
}
