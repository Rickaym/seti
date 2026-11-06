const KEY = 'seti.palette.recent'
const KEEP = 20

/** Moves `id` to the front, keeping at most `keep` ids. */
export const withRecent = (recent: readonly string[], id: string, keep = KEEP): string[] =>
  [id, ...recent.filter((other) => other !== id)].slice(0, keep)

export function loadRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/** Remembers that `id` was opened, and returns the new list. */
export function rememberRecent(id: string): string[] {
  const next = withRecent(loadRecent(), id)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Storage can be blocked; recents then last for this visit only.
  }
  return next
}
