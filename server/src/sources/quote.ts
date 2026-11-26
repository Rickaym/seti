/** Quotes shorter than this, once normalised, are too short to say anything and never verify. */
const QUOTE_MIN = 12

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }

const LEAD = /^(?:>|[-*+\u2022] |#{1,6} )/

/** A line without the quote marks, bullets and heading marks it starts with. */
function bare(line: string): string {
  let rest = line.trimStart()
  while (LEAD.test(rest)) {
    rest = rest.replace(LEAD, '').trimStart()
  }
  return rest
}

/**
 * Text as a quote is compared: NFKC; Slack markup (`<url|label>`, `<@U..|name>`, `<#C..|name>`,
 * `<!..|label>`) cut to its label and a bare `<url>` to the URL; Markdown links cut to their
 * text; HTML entities decoded; quote marks, bullets and heading marks at a line's start dropped;
 * emphasis, code and strike marks, backslashes, `@` and all quotation marks dropped; white space
 * collapsed.
 */
export function normalise(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/<[@#!][^<>|\s]*\|([^<>]*)>/g, '$1')
    .replace(/<[@#!][^<>]*>/g, '')
    .replace(/<((?:https?|mailto):[^<>|\s]*)\|([^<>]*)>/g, '$2')
    .replace(/<((?:https?|mailto):[^<>\s]*)>/g, '$1')
    .replace(/\[([^\]\n]{0,400})\]\([^)\s]{0,2048}\)/g, '$1')
    .split('\n')
    .map(bare)
    .join('\n')
    .replace(/[*_~`\\@"'\u2018\u2019\u201a\u201b\u201c\u201d\u201e\u201f\u00ab\u00bb\u2039\u203a]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const ELLIPSIS = /\.\.\.|\u2026|\[\.\.\.\]|\[\u2026\]/

/**
 * Whether a quote stands in the item's text once both are normalised. An ellipsis marks words
 * left out: each part must appear in order, and the parts together must reach the minimum length.
 */
export function quoteFits(quote: string, itemText: string): boolean {
  const parts = quote
    .split(ELLIPSIS)
    .map(normalise)
    .filter((part) => part !== '')
  const haystack = normalise(itemText)
  if (parts.join(' ').length < QUOTE_MIN) {
    return false
  }
  let from = 0
  for (const part of parts) {
    const found = haystack.indexOf(part, from)
    if (found < 0) {
      return false
    }
    from = found + part.length
  }
  return true
}
