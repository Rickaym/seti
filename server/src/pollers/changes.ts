import type { PollerItem } from '@seti/shared'

/** An item a poller saw before, as Seti keeps it between runs. */
export interface SeenItem {
  key: string
  fingerprint: string
  kind: string
  title: string
  url: string | null
  fields: Record<string, unknown>
}

export type Change =
  | { type: 'new'; item: PollerItem }
  | { type: 'changed'; item: PollerItem; before: SeenItem }
  | { type: 'gone'; before: SeenItem }

export interface DiffOptions {
  /** The first successful run records what is there and reports nothing. */
  baseline: boolean
  detectGone: boolean
  /** Whether the run returned every item, so a missing key means the item is gone. */
  complete: boolean
}

/** New keys, keys whose fingerprint changed and, when asked, keys the run no longer returned. */
export function diffItems(seen: ReadonlyMap<string, SeenItem>, items: readonly PollerItem[], options: DiffOptions) {
  if (options.baseline) {
    return []
  }
  const changes: Change[] = []
  for (const item of items) {
    const before = seen.get(item.key)
    if (before === undefined) {
      changes.push({ type: 'new', item })
    } else if (before.fingerprint !== item.fingerprint) {
      changes.push({ type: 'changed', item, before })
    }
  }
  if (options.detectGone && options.complete) {
    const keys = new Set(items.map((item) => item.key))
    for (const before of seen.values()) {
      if (!keys.has(before.key)) {
        changes.push({ type: 'gone', before })
      }
    }
  }
  return changes
}

/** An item's own kind names its events: issue, issue.changed, issue.gone; else new, changed, gone. */
export function changeKind(change: Change): string {
  const kind = change.type === 'gone' ? change.before.kind : change.item.kind
  if (kind === '') {
    return change.type
  }
  return change.type === 'new' ? kind : `${kind}.${change.type}`
}

const show = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value))

function fieldLines(fields: Record<string, unknown>): string[] {
  return Object.entries(fields).map(([name, value]) => `${name}: ${show(value)}`)
}

function changedLines(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  return names
    .filter((name) => show(before[name]) !== show(after[name]))
    .map((name) => `${name}: ${show(before[name] ?? '(none)')} -> ${show(after[name] ?? '(none)')}`)
}

/** The title, text and link of the event a change reports. */
export function describeChange(change: Change): { title: string; detail: string; url: string | null } {
  switch (change.type) {
    case 'new': {
      const { item } = change
      const detail = [item.body, ...fieldLines(item.fields)].filter((line) => line !== '').join('\n')
      return { title: item.title, detail, url: item.url }
    }
    case 'changed': {
      const { item, before } = change
      const lines = changedLines(before.fields, item.fields)
      const moved = before.title === item.title ? [] : [`title: ${before.title} -> ${item.title}`]
      const detail = [...moved, ...lines, ...(item.body === '' ? [] : ['', item.body])].join('\n').trim()
      return { title: `Changed: ${item.title}`, detail, url: item.url }
    }
    case 'gone':
      return { title: `Gone: ${change.before.title}`, detail: 'No longer listed', url: change.before.url }
  }
}
