/** A handle the composer can suggest after @, with a line that says who it is. */
export interface MentionOption {
  handle: string
  detail: string
  /** Muted tasks and inactive ones rank after the rest. */
  quiet: boolean
}

/** The @word the caret sits in, as typed so far, or null when it is not in one. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const match = /(^|[^\w@./-])@([a-z0-9-]*)$/i.exec(before)
  if (match === null) {
    return null
  }
  const query = match[2] ?? ''
  return { start: caret - query.length - 1, query: query.toLowerCase() }
}

/** Options whose handle starts with the query first, then those containing it; quiet ones last. */
export function rankMentions(options: readonly MentionOption[], query: string, limit: number): MentionOption[] {
  const scored = options.flatMap((option) => {
    const at = option.handle.indexOf(query)
    if (at < 0) {
      return []
    }
    return [{ option, score: (at === 0 ? 0 : 2) + (option.quiet ? 1 : 0) }]
  })
  return scored
    .toSorted((a, b) => (a.score === b.score ? a.option.handle.localeCompare(b.option.handle) : a.score - b.score))
    .slice(0, limit)
    .map(({ option }) => option)
}

/** Replaces the @word from `start` to the caret with the handle and a space. */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  handle: string,
): { text: string; caret: number } {
  const after = text.slice(caret).replace(/^[a-z0-9-]*/i, '')
  const inserted = `@${handle}${after.startsWith(' ') ? '' : ' '}`
  return {
    text: text.slice(0, start) + inserted + after,
    caret: start + inserted.length + (after.startsWith(' ') ? 1 : 0),
  }
}
