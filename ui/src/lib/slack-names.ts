import { idsIn, readableSlack, slackDestination, slackSendTarget, type SlackNames } from '@seti/shared'
import { useEffect, useSyncExternalStore } from 'react'
import { apiGet } from '@/api'

/** Names fetched so far by id; null for an id Seti does not know a name for. */
const known = new Map<string, string | null>()
const wanted = new Set<string>()
const listeners = new Set<() => void>()
let version = 0
let timer: ReturnType<typeof setTimeout> | null = null

function settle(ids: readonly string[], found: SlackNames): void {
  for (const id of ids) {
    known.set(id, found[id] ?? null)
  }
  version += 1
  listeners.forEach((listener) => {
    listener()
  })
}

/** Asks once for every id the rows on screen wanted in the same moment. */
function flush(): void {
  timer = null
  const ids = [...wanted]
  wanted.clear()
  apiGet<SlackNames>(`/channels/slack-names?ids=${encodeURIComponent(ids.join(','))}`)
    .then((found) => {
      settle(ids, found)
    })
    .catch(() => {
      settle(ids, {})
    })
}

/** Names Seti just learned, as the task stream reports them; rows on screen show them at once. */
export function learnedSlackNames(found: SlackNames): void {
  settle(Object.keys(found), found)
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The names Seti knows of these Slack ids, and whether it is still asking about any of them. */
export function useSlackLookup(ids: readonly string[]): { names: ReadonlyMap<string, string>; asking: boolean } {
  const key = ids.join(',')
  useEffect(() => {
    const missing = key.split(',').filter((id) => id !== '' && !known.has(id))
    missing.forEach((id) => wanted.add(id))
    if (missing.length > 0 && timer === null) {
      timer = setTimeout(flush, 50)
    }
  }, [key])
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  )
  const names = new Map(
    ids.flatMap((id) => {
      const name = known.get(id)
      return name === undefined || name === null ? [] : [[id, name] as const]
    }),
  )
  return { names, asking: ids.some((id) => !known.has(id)) }
}

/** The names Seti knows of these Slack ids; an id stays out of the map until its name is known. */
export const useSlackNames = (ids: readonly string[]): ReadonlyMap<string, string> => useSlackLookup(ids).names

const messageOf = (input: unknown): string => {
  const value = typeof input === 'object' && input !== null ? (input as { message?: unknown }).message : undefined
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

/** A Slack send's row line, `Send to #deploys: Deploy done` with mentions by name; null otherwise. */
export function useSlackSummary(call: { name: string; input: unknown }): string | null {
  const target = slackSendTarget(call.name, call.input)
  const text = target === null ? '' : messageOf(call.input)
  const names = useSlackNames(target === null ? [] : [target, ...idsIn(text)])
  const where = slackDestination(call.name, call.input, names)
  return where === null ? null : `${where}: ${readableSlack(text, names, false)}`
}
