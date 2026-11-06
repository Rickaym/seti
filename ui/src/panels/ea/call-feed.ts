import type { EaHistoryEntry } from '@seti/shared'
import type { ActionItem, CaptionItem, SpeechItem } from '@/components/ea/captions'

/** A caption line or tool call of the call that the stored conversation does not show yet. */
export type FeedItem = SpeechItem | ActionItem

const normal = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

const settled = (item: FeedItem) => (item.kind === 'action' ? !item.running : item.final)

/** What the stored entries of the latest call said, per speaker, and the tool calls they hold. */
interface Stored {
  user: string
  bot: string
  calls: Set<string>
}

function storedCall(entries: readonly EaHistoryEntry[]): Stored {
  const start = entries.findLastIndex((entry) => entry.kind === 'call')
  const said: Record<'user' | 'bot', string[]> = { user: [], bot: [] }
  const calls = new Set<string>()
  for (const { kind, message } of entries.slice(start + 1)) {
    if (kind !== 'message') {
      continue
    }
    if (message.role === 'user') {
      said.user.push(message.content)
    } else if (message.role === 'assistant') {
      said.bot.push(message.content ?? '')
      for (const call of message.tool_calls ?? []) {
        calls.add(call.id)
      }
    } else if (message.role === 'tool') {
      calls.add(message.tool_call_id)
    }
  }
  return { user: normal(said.user.join(' ')), bot: normal(said.bot.join(' ')), calls }
}

function landed(item: FeedItem, stored: Stored): boolean {
  if (!settled(item)) {
    return false
  }
  if (item.kind === 'action') {
    return item.callId !== null && stored.calls.has(item.callId)
  }
  const text = normal(item.text)
  return text !== '' && stored[item.kind].includes(text)
}

/** The call's lines and tool calls not stored yet; a stored line takes finished ones before it. */
export function inFlight(items: readonly CaptionItem[], entries: readonly EaHistoryEntry[]): FeedItem[] {
  const feed = items.filter((item): item is FeedItem => item.kind !== 'marker')
  const stored = storedCall(entries)
  const cut = feed.findLastIndex((item) => landed(item, stored))
  return feed.filter((item, index) => index > cut || !settled(item))
}

/** Counts the finished lines, so the stored conversation can be fetched again as each lands. */
export const settledCount = (items: readonly CaptionItem[]) =>
  items.filter((item) => item.kind !== 'marker' && settled(item)).length
