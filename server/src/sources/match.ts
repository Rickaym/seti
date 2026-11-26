import { rowEvents, slackPlace, type SourceMatch, type SourcePreview } from '@seti/shared'
import { messages } from '../db.js'
import { slackNames } from '../store/slack-names.js'
import { sourceItems, transcriptText, type SourceItem } from '../store/sources.js'
import { itemText } from './item.js'
import { quoteFits } from './quote.js'
import { refOfUrl, type UrlRef } from './refs.js'

/** The agent's newest items under the URL's key, else under the nearest key that holds it. */
async function itemsFor(taskId: string, url: UrlRef): Promise<SourceItem[]> {
  for (const ref of [url.ref, ...url.parents]) {
    const prefix = ref.startsWith('linear:') && ref.includes('#')
    const items = await sourceItems.find(taskId, ref, prefix)
    if (items.length > 0) {
      return items
    }
  }
  return []
}

/** The text of an item, read from the tool result in the transcript row it points at. */
async function textOf(item: SourceItem): Promise<string | null> {
  const row = await messages.get(item.task_id, item.message_id)
  const ended = row === undefined ? [] : rowEvents(row).filter((event) => event.type === 'tool.ended')
  const result = ended.find((event) => event.callId === item.call_id)
  return result === undefined ? null : itemText(result.result.text, item.spans)
}

async function verified(items: readonly SourceItem[], quote: string | null): Promise<boolean> {
  if (quote === null) {
    return false
  }
  for (const item of items) {
    const text = await textOf(item)
    if (text !== null && quoteFits(quote, text)) {
      return true
    }
  }
  return false
}

async function preview(item: SourceItem): Promise<SourcePreview> {
  const place =
    item.kind === 'slack' ? slackPlace(item.container, await slackNames.of([item.container])) : item.container
  return { kind: item.kind, container: item.container, place, at: item.at, permalink: item.permalink }
}

/** One cited link checked against the agent's ledger. */
async function matchOne(taskId: string, href: string, quote: string | null, kept: boolean): Promise<SourceMatch> {
  const url = refOfUrl(href)
  const items = url === null ? [] : await itemsFor(taskId, url)
  const first = items[0]
  if (first !== undefined) {
    return { href, source: await preview(first), verified: await verified(items, quote), unread: false }
  }
  const needles = url?.needles ?? null
  const unread = kept && needles !== null && !(await transcriptText.mentions(taskId, needles))
  return { href, source: null, verified: false, unread }
}

/**
 * Checks the links one of the agent's messages cites against its own ledger: the item each names,
 * whether the quote tied to it is in that item, and whether a permalink is one it never saw.
 */
export async function matchSources(
  taskId: string,
  refs: readonly { href: string; quote: string | null }[],
): Promise<SourceMatch[]> {
  const kept = await transcriptText.present(taskId)
  const matched: SourceMatch[] = []
  for (const { href, quote } of refs) {
    matched.push(await matchOne(taskId, href, quote, kept))
  }
  return matched
}
