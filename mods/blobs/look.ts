import type { ModAgentPlace, TaskDisplayStatus } from '@seti/mod-api'

/** How a blob's face looks; only `happy` moves. */
export type Expression = 'happy' | 'asking' | 'alert' | 'asleep' | 'content' | 'error' | 'neutral'

/** Each status as a face, so the blob tells the state without its colour. */
export const EXPRESSION: Readonly<Record<TaskDisplayStatus, Expression>> = {
  running: 'happy',
  asking: 'asking',
  blocked: 'alert',
  idle: 'asleep',
  complete: 'content',
  stopped: 'neutral',
  error: 'error',
  interrupted: 'neutral',
}

export const SIZES = ['Small', 'Medium', 'Large'] as const
export type BlobSize = (typeof SIZES)[number]

/** A bookmark's side in CSS pixels, with a mouse and on a touch screen; blobs.css matches it. */
export const SIZE_PX: Readonly<Record<BlobSize, { fine: number; coarse: number }>> = {
  Small: { fine: 20, coarse: 24 },
  Medium: { fine: 28, coarse: 32 },
  Large: { fine: 34, coarse: 40 },
}

export interface BlobSettings {
  size: BlobSize
  animation: boolean
  /** Where blobs show; elsewhere Seti's bar and marker stay. */
  places: Readonly<Record<'list' | 'needsYou' | 'grid', boolean>>
}

export const DEFAULT_SETTINGS: BlobSettings = {
  size: 'Medium',
  animation: true,
  places: { list: true, needsYou: true, grid: true },
}

const oneOf = <T extends string>(options: readonly T[], value: unknown, fallback: T): T =>
  options.find((option) => option === value) ?? fallback

const flag = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback)

/** The mod's saved settings, with defaults for missing or unknown values and before they load. */
export function blobSettings(values: Readonly<Record<string, unknown>> | null): BlobSettings {
  const d = DEFAULT_SETTINGS
  if (values === null) {
    return d
  }
  return {
    size: oneOf(SIZES, values.size, d.size),
    animation: flag(values.animation, d.animation),
    places: {
      list: flag(values.list, d.places.list),
      needsYou: flag(values['needs-you'], d.places.needsYou),
      grid: flag(values.grid, d.places.grid),
    },
  }
}

/** Whether a blob draws in a place; the legend, the phone header and Home follow the list. */
export function showsIn(settings: BlobSettings, place: ModAgentPlace): boolean {
  switch (place) {
    case 'list':
    case 'needsYou':
    case 'grid':
      return settings.places[place]
    case 'legend':
    case 'header':
    case 'home':
      return settings.places.list
  }
}

/** Running blobs start at one of a few points of their 4.8 s cycle, so they never move in step. */
const START_STEP_MS = 800
const START_STEPS = 6

/** FNV-1a: a stable, well-spread number from an agent's id. */
function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export interface BlobLook {
  expression: Expression
  /**
   * A negative animation delay. A few shared values keep blobs out of step while the browser wakes
   * for animation events at only a few moments of each cycle.
   */
  delay: string
}

/** How an agent's blob looks; with no agent, as in the legend, no offset. */
export function blobLook(status: TaskDisplayStatus, agentId: string | null): BlobLook {
  const offset = agentId === null ? 0 : (hash(agentId) % START_STEPS) * START_STEP_MS
  return { expression: EXPRESSION[status], delay: `-${String(offset)}ms` }
}
