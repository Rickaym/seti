/** A source a message cites, shown as a numbered mark beside the claim and in its Sources list. */
export interface Reference {
  /** The mark's number, from 1, in order of first appearance in the message. */
  n: number
  /** The source's http or https URL; null for a footnote that names a source without a link. */
  href: string | null
  /** A footnote's own words without its link, as plain text; null when it has none. */
  note: string | null
  /** The text of the quote tied to this reference, as plain text; null when none is. */
  quote: string | null
}

/** The references of one rendered message. */
export interface ReferenceSet {
  /** Random per message view, so raw HTML in a message cannot pass for one of Seti's marks. */
  token: string
  refs: Reference[]
}

/** The hast property that ties a link, mark or quote to its reference. */
export const REF_PROPERTY = 'dataSetiRef'

/** The hast property of the node where the Sources list goes. */
export const SOURCES_PROPERTY = 'dataSetiSources'

/** More references than this in one message render as plain links. */
export const MAX_REFS = 99

/** A random token for one message view. */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** The value a node carries to name reference `n` of the set. */
export const refValue = (set: ReferenceSet, n: number) => `${set.token}:${String(n)}`

/** The reference a node's property names, or null when it names none of this set's. */
export function referenceOf(set: ReferenceSet | null, value: unknown): Reference | null {
  if (set === null || typeof value !== 'string' || !value.startsWith(`${set.token}:`)) {
    return null
  }
  const n = Number(value.slice(set.token.length + 1))
  return set.refs.find((ref) => ref.n === n) ?? null
}

/** Whether a node's property marks this set's Sources list. */
export const isSourcesOf = (set: ReferenceSet | null, value: unknown) => set !== null && value === set.token
