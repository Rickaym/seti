import { POLLER_LIMITS } from '@seti/shared'
import { XMLParser } from 'fast-xml-parser'

/** One entry of an RSS or Atom feed, as parseFeed gives it to a poll script. */
export interface FeedEntry {
  id: string
  title: string
  link: string | null
  summary: string
  published: string | null
  updated: string | null
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ['item', 'entry', 'link'].includes(name),
})

type Node = Record<string, unknown>

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The text of an element, whether it came as a string or an object with #text. */
function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value).trim()
  }
  if (Array.isArray(value)) {
    return text(value[0])
  }
  if (isNode(value)) {
    return text(value['#text'])
  }
  return ''
}

const orNull = (value: string) => (value === '' ? null : value)

const first = (...values: unknown[]) => values.map(text).find((value) => value !== '') ?? ''

/** Atom links carry href attributes, RSS links their text; Atom prefers the alternate one. */
function link(value: unknown): string | null {
  const links: unknown[] = Array.isArray(value) ? value : [value]
  const hrefOf = (entry: unknown) => (isNode(entry) ? text(entry['@href']) : text(entry))
  const alternate = links.find(
    (entry) => isNode(entry) && (entry['@rel'] === undefined || entry['@rel'] === 'alternate'),
  )
  return orNull(hrefOf(alternate ?? links[0]))
}

function rssEntry(item: Node): FeedEntry {
  const url = link(item.link)
  const title = text(item.title)
  return {
    id: first(item.guid, url, title),
    title,
    link: url,
    summary: first(item.description, item.encoded),
    published: orNull(first(item.pubDate, item.date)),
    updated: orNull(text(item.date)),
  }
}

function atomEntry(entry: Node): FeedEntry {
  const url = link(entry.link)
  const title = text(entry.title)
  return {
    id: first(entry.id, url, title),
    title,
    link: url,
    summary: first(entry.summary, entry.content),
    published: orNull(first(entry.published, entry.issued)),
    updated: orNull(first(entry.updated, entry.modified)),
  }
}

const nodes = (value: unknown): Node[] => (Array.isArray(value) ? value.filter(isNode) : [])

/** Reads RSS 2.0, RSS 1.0 or Atom; throws when the text is none of them. */
export function parseFeed(xml: string): FeedEntry[] {
  if (/<!ENTITY/i.test(xml)) {
    throw new Error('Feeds that declare their own entities are not read')
  }
  let doc: unknown
  try {
    doc = parser.parse(xml) as unknown
  } catch (e) {
    throw new Error(`Not a feed: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
  }
  const root = isNode(doc) ? doc : {}
  const rss = isNode(root.rss) && isNode(root.rss.channel) ? nodes(root.rss.channel.item) : null
  const rdf = isNode(root.RDF) ? nodes(root.RDF.item) : null
  const atom = isNode(root.feed) ? nodes(root.feed.entry).map(atomEntry) : null
  const entries = atom ?? (rss ?? rdf)?.map(rssEntry)
  if (entries === undefined) {
    throw new Error('Not an RSS or Atom feed')
  }
  return entries.filter((entry) => entry.id !== '').slice(0, POLLER_LIMITS.maxItems)
}
