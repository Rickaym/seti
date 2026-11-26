import type { SourceMatch } from '@seti/shared'
import { createContext, useContext, useEffect, useSyncExternalStore } from 'react'
import { apiPost } from '@/api'
import type { Reference } from './reference-set'

/** The agent whose evidence ledger checks the references of the message being rendered. */
export const LedgerTaskContext = createContext<string | null>(null)

type Entry = { state: 'asking' } | { state: 'done'; matches: ReadonlyMap<string, SourceMatch> }

/** Answers by agent and message references; a message asks once however many marks it shows. */
const answers = new Map<string, Entry>()
const listeners = new Set<() => void>()
const KEPT = 300

const NONE: ReadonlyMap<string, SourceMatch> = new Map()

function settle(key: string, matches: ReadonlyMap<string, SourceMatch>): void {
  if (answers.size >= KEPT) {
    answers.clear()
  }
  answers.set(key, { state: 'done', matches })
  listeners.forEach((listener) => {
    listener()
  })
}

function ask(key: string, taskId: string, refs: readonly { href: string; quote: string | null }[]): void {
  if (answers.has(key)) {
    return
  }
  answers.set(key, { state: 'asking' })
  apiPost<SourceMatch[]>(`/tasks/${encodeURIComponent(taskId)}/sources`, { refs })
    .then((found) => {
      settle(key, new Map(found.map((match) => [match.href, match])))
    })
    .catch(() => {
      settle(key, NONE)
    })
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The links of a message with their quotes, as the ledger is asked about them. */
const asked = (refs: readonly Reference[]) =>
  refs.flatMap((ref) => (ref.href === null ? [] : [{ href: ref.href, quote: ref.quote }]))

/**
 * What the agent's ledger says of each link of a message: nothing until it answers, and nothing
 * outside an agent's chat or when the answer fails, since a missing mark is never an error.
 */
export function useSourceMatches(refs: readonly Reference[]): ReadonlyMap<string, SourceMatch> {
  const taskId = useContext(LedgerTaskContext)
  const links = asked(refs)
  const key = taskId === null || links.length === 0 ? null : `${taskId}\n${JSON.stringify(links)}`
  useEffect(() => {
    if (key !== null && taskId !== null) {
      ask(key, taskId, links)
    }
  })
  const entry = useSyncExternalStore(subscribe, () => (key === null ? undefined : answers.get(key)))
  return entry?.state === 'done' ? entry.matches : NONE
}
