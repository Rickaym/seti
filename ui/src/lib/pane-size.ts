/** A side pane the user can widen or narrow; widths are CSS pixels. */
export interface PaneSpec {
  /** Names the stored width, as in `seti.pane.<id>`. */
  id: string
  initial: number
  min: number
  max: number
  /** The most of its row the pane may take, so the main area always keeps room. */
  share: number
}

/** Which edge of the row the pane sits on; a pane on the end grows as its handle moves left. */
export type PaneSide = 'start' | 'end'

export const PANES = {
  agents: { id: 'agents-list', initial: 320, min: 220, max: 560, share: 0.45 },
  context: { id: 'context-list', initial: 288, min: 200, max: 520, share: 0.45 },
  settings: { id: 'settings-list', initial: 224, min: 180, max: 400, share: 0.4 },
  team: { id: 'group-chat', initial: 384, min: 280, max: 640, share: 0.4 },
  files: { id: 'files', initial: 560, min: 320, max: 1200, share: 0.75 },
  processes: { id: 'processes', initial: 576, min: 360, max: 960, share: 0.8 },
} as const satisfies Record<string, PaneSpec>

export const KEY_STEP = 16
export const PAGE_STEP = 64

const storageKey = (spec: PaneSpec) => `seti.pane.${spec.id}`

/** The widest the pane may be in a row `room` pixels wide (0 when unknown); never below its min. */
function maxWidth(spec: PaneSpec, room = 0): number {
  const limit = room <= 0 ? spec.max : Math.min(spec.max, room * spec.share)
  return Math.max(spec.min, Math.floor(limit))
}

export function clampWidth(width: number, spec: PaneSpec, room = 0): number {
  return Math.round(Math.min(Math.max(width, spec.min), maxWidth(spec, room)))
}

export function storedWidth(spec: PaneSpec): number {
  try {
    const raw = localStorage.getItem(storageKey(spec))
    const value = raw === null ? Number.NaN : Number(raw)
    return Number.isFinite(value) ? clampWidth(value, spec) : spec.initial
  } catch {
    return spec.initial
  }
}

export function storeWidth(spec: PaneSpec, width: number): void {
  try {
    localStorage.setItem(storageKey(spec), String(Math.round(width)))
  } catch {
    // Storage can be blocked; the width then lasts for this visit only.
  }
}

export function forgetWidth(spec: PaneSpec): void {
  try {
    localStorage.removeItem(storageKey(spec))
  } catch {
    // Storage can be blocked; nothing was kept then.
  }
}

/** Where a key moves the splitter: arrows and Page keys step, Home and End go to the ends. */
export function keyedWidth(
  key: string,
  spec: PaneSpec,
  side: PaneSide,
  { width, room }: { width: number; room: number },
): number | null {
  const grow = side === 'start' ? 'ArrowRight' : 'ArrowLeft'
  const shrink = side === 'start' ? 'ArrowLeft' : 'ArrowRight'
  const steps: Record<string, number> = {
    [grow]: KEY_STEP,
    [shrink]: -KEY_STEP,
    PageUp: PAGE_STEP,
    PageDown: -PAGE_STEP,
  }
  if (key === 'Home') {
    return spec.min
  }
  if (key === 'End') {
    return maxWidth(spec, room)
  }
  const step = steps[key]
  return step === undefined ? null : clampWidth(width + step, spec, room)
}
