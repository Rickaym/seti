/**
 * Replays the edit that turned `base` into `next` on `current`, a later version of `base` the
 * user typed on, as one splice found from their common prefix and suffix. Returns `current`
 * unchanged when the user also changed the text that edit replaces.
 */
export function rebaseEdit(base: string, next: string, current: string): string {
  const shorter = Math.min(base.length, next.length)
  let prefix = 0
  while (prefix < shorter && base[prefix] === next[prefix]) {
    prefix++
  }
  let suffix = 0
  while (suffix < shorter - prefix && base[base.length - 1 - suffix] === next[next.length - 1 - suffix]) {
    suffix++
  }
  const removed = base.slice(prefix, base.length - suffix)
  const inserted = next.slice(prefix, next.length - suffix)
  if (
    current.slice(0, prefix) !== base.slice(0, prefix) ||
    current.slice(prefix, prefix + removed.length) !== removed
  ) {
    return current
  }
  return current.slice(0, prefix) + inserted + current.slice(prefix + removed.length)
}
