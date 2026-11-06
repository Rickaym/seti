import type { MentionPlace } from '@seti/shared'

/** A reference from one PR's text to another PR or issue on GitHub. */
export interface PrRef {
  slug: string
  number: number
  place: MentionPlace
  /** True when written as a `/pull/` URL, so it names a pull request for certain. */
  pull: boolean
}

export interface PrText {
  place: MentionPlace
  text: string
}

const MAX_TEXT = 20_000
const MAX_REFS = 50

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const INLINE_CODE = /`[^`\n]*`/g
const HTML_COMMENT = /<!--[\s\S]*?-->/g
const URL_REF = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)/gi
const SLUG_REF = /(?<![\w./-])([\w-]+)\/([\w.-]+)#(\d+)\b/g
const BARE_REF = /(?<![\w&#/-])#(\d+)\b/g

/** Drops fenced code blocks line by line, so an unclosed fence hides the rest as GitHub does. */
function withoutFences(text: string): string {
  const kept: string[] = []
  let fence: string | null = null
  for (const line of text.split('\n')) {
    const marker = FENCE.exec(line)?.[1] ?? null
    if (fence === null && marker !== null) {
      fence = marker
    } else if (fence !== null && marker?.startsWith(fence) === true) {
      fence = null
    } else if (fence === null) {
      kept.push(line)
    }
  }
  return kept.join('\n')
}

const prose = (text: string) =>
  withoutFences(text.slice(0, MAX_TEXT)).replace(HTML_COMMENT, ' ').replace(INLINE_CODE, ' ')

function refsIn(slug: string, { place, text }: PrText): PrRef[] {
  const clean = prose(text)
  const refs: PrRef[] = Array.from(clean.matchAll(URL_REF), ([, owner = '', repo = '', kind = '', number = '']) => ({
    slug: `${owner}/${repo}`,
    number: Number(number),
    place,
    pull: kind.toLowerCase() === 'pull',
  }))
  const noUrls = clean.replace(URL_REF, ' ')
  for (const [, owner = '', repo = '', number = ''] of noUrls.matchAll(SLUG_REF)) {
    refs.push({ slug: `${owner}/${repo}`, number: Number(number), place, pull: false })
  }
  for (const [, number = ''] of noUrls.replace(SLUG_REF, ' ').matchAll(BARE_REF)) {
    refs.push({ slug, number: Number(number), place, pull: false })
  }
  return refs
}

export const refKey = (slug: string, number: number) => `${slug.toLowerCase()}#${String(number)}`

/** First mention of each other PR or issue outside code; bare `#N` means the PR's own repo. */
export function extractPrRefs(self: { slug: string; number: number }, texts: readonly PrText[]): PrRef[] {
  const seen = new Set([refKey(self.slug, self.number)])
  const refs: PrRef[] = []
  for (const text of texts) {
    for (const ref of refsIn(self.slug, text)) {
      const key = refKey(ref.slug, ref.number)
      if (!seen.has(key)) {
        seen.add(key)
        refs.push(ref)
      }
      if (refs.length >= MAX_REFS) {
        return refs
      }
    }
  }
  return refs
}
