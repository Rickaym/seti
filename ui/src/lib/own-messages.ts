/** How far below the top of the view a message lands when stepped to. */
export const READ_LINE = 12
/** Movement under this many pixels still counts as the view the last step left. */
const DRIFT = 4

/** The message the last step landed on, and where it sat once the view settled. */
interface OwnCursor {
  index: number
  top: number
}

/** Where the user's own messages sit in a transcript's view, measured from its top edge. */
export interface OwnView {
  /** Top and bottom of each own message, oldest first. */
  tops: readonly number[]
  bottoms: readonly number[]
  height: number
  cursor: OwnCursor | null
  /** Earlier pages exist, which may hold more own messages. */
  hasOlder: boolean
  /** The server finds own messages past the loaded rows, so steps reach ones not loaded yet. */
  indexed: boolean
  /** The view shows the newest messages at its bottom already. */
  atLatest: boolean
}

/** A step lands on an own message, loads an earlier page first, or returns to the newest. */
type OwnTarget = number | 'older' | 'latest'

export type OwnDirection = 'back' | 'forward'

export interface OwnNav {
  /** Some own message sits out of view, or the user is stepping through them. */
  show: boolean
  back: OwnTarget | null
  forward: OwnTarget | null
  /** The landed message's place among the loaded ones, once every page is loaded. */
  position: { at: number; of: number } | null
}

/** The cursor's index while its message has not moved since the step, else null. */
function settledCursor({ tops, cursor }: OwnView): number | null {
  if (cursor === null) {
    return null
  }
  const top = tops[cursor.index]
  return top !== undefined && Math.abs(top - cursor.top) <= DRIFT ? cursor.index : null
}

const orElse = (index: number, fallback: OwnTarget | null): OwnTarget | null => (index >= 0 ? index : fallback)

function backTarget(view: OwnView, cursor: number | null): OwnTarget | null {
  const index = cursor === null ? view.tops.findLastIndex((top) => top < READ_LINE - DRIFT) : cursor - 1
  return orElse(index, view.hasOlder ? 'older' : null)
}

function forwardTarget(view: OwnView, cursor: number | null): OwnTarget | null {
  const next = cursor === null ? view.tops.findIndex((top) => top > READ_LINE + DRIFT) : cursor + 1
  return orElse(next < view.tops.length ? next : -1, view.atLatest ? null : 'latest')
}

const outOfView = (view: OwnView) =>
  view.tops.some((top, index) => (view.bottoms[index] ?? top) <= 0 || top >= view.height)

/** What stepping back and forward through the user's own messages does from this view. */
export function ownNav(view: OwnView): OwnNav {
  const cursor = settledCursor(view)
  return {
    show: cursor !== null || outOfView(view) || (view.indexed && view.hasOlder),
    back: backTarget(view, cursor),
    forward: forwardTarget(view, cursor),
    position: cursor === null || view.hasOlder ? null : { at: cursor + 1, of: view.tops.length },
  }
}

/** Steps measure afresh, so which message a target names never changes the buttons. */
const sameTarget = (a: OwnTarget | null, b: OwnTarget | null) =>
  a === b || (typeof a === 'number' && typeof b === 'number')

/** Navs that show the same buttons, so scrolling past own messages renders nothing new. */
export const sameNav = (a: OwnNav, b: OwnNav): boolean =>
  a.show === b.show &&
  sameTarget(a.back, b.back) &&
  sameTarget(a.forward, b.forward) &&
  a.position?.at === b.position?.at &&
  a.position?.of === b.position?.of

/** What a step does: land on a loaded message, ask the server, walk earlier pages, or go newest. */
export type OwnMove = 'land' | 'find' | 'walk' | 'latest' | 'stop'

interface MoveContext {
  indexed: boolean
  /** The view shows a stretch far back, so later own messages may not be loaded. */
  detached: boolean
  /** Earlier pages a walk may still load. */
  pages: number
}

/** How a step reaches the target the view names in its direction. */
export function ownMove(target: OwnTarget | null, { indexed, detached, pages }: MoveContext): OwnMove {
  if (typeof target === 'number') {
    return 'land'
  }
  if (target === 'older') {
    if (indexed) {
      return 'find'
    }
    return pages > 0 ? 'walk' : 'stop'
  }
  if (target === 'latest') {
    return indexed && detached ? 'find' : 'latest'
  }
  return 'stop'
}

/** Earlier pages may hold own messages until the server says none lies before the oldest row. */
export const olderOwn = (hasOlder: boolean, oldest: number | undefined, noneBefore: number | null): boolean =>
  hasOlder && (noneBefore === null || oldest === undefined || oldest > noneBefore)
