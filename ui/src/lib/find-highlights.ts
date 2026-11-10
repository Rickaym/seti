/** Ranges one find shows: every match, and the ones it stands on now. */
export interface FindRanges {
  all: Range[]
  current: Range[]
}

/** Every view with find open adds its ranges here; the two highlights show them all. */
const marked = new Map<symbol, FindRanges>()

function paint(): void {
  const all = new Highlight()
  const current = new Highlight()
  for (const ranges of marked.values()) {
    ranges.all.forEach((range) => all.add(range))
    ranges.current.forEach((range) => current.add(range))
  }
  CSS.highlights.set('seti-find', all)
  CSS.highlights.set('seti-find-current', current)
}

/** Shows `owner`'s matches with the others' on screen, or drops them when `ranges` is null. */
export function showFindRanges(owner: symbol, ranges: FindRanges | null): void {
  if (ranges === null) {
    marked.delete(owner)
  } else {
    marked.set(owner, ranges)
  }
  paint()
}
