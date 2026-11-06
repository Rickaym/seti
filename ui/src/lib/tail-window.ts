/** A window that shows every loaded row. */
export const WHOLE = Number.NEGATIVE_INFINITY

/** Where the shown rows start: at row `from` once it is set, else `size` rows from the end. */
export function windowStart(ids: readonly number[], from: number | null, size: number): number {
  if (from === null) {
    return Math.max(0, ids.length - size)
  }
  const index = ids.findIndex((id) => id >= from)
  return index === -1 ? ids.length : index
}

/** The row a window starting at `start` grows back to by `step` rows, or WHOLE at the first. */
export function grownFrom(ids: readonly number[], start: number, step: number): number {
  return start <= step ? WHOLE : (ids[start - step] ?? WHOLE)
}
