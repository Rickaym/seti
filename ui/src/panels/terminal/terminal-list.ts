import { TERMINAL_NAME_MAX, type TerminalRef, type Task } from '@seti/shared'
import type { Route } from '@/lib/route'

/** This device's own terminals, and the one shown last. */
export interface TerminalList {
  terminals: TerminalRef[]
  recent: string | null
}

/** Where a new shell opens: an agent's directory, or the home folder. */
export interface TerminalPlace {
  taskId: string | null
  name: string
}

export const HOME_PLACE: TerminalPlace = { taskId: null, name: 'Terminal' }

/** The server runs 16 terminals at most, so a list never needs more. */
const LIST_MAX = 16

export const EMPTY_LIST: TerminalList = { terminals: [], recent: null }

/** The agent in view opens shells in its directory; anywhere else they open in the home folder. */
export function placeFor(route: Pick<Route, 'section' | 'id'>, tasks: readonly Pick<Task, 'id' | 'title'>[]) {
  const task = route.section === 'agents' && route.id !== null ? tasks.find((t) => t.id === route.id) : undefined
  return task === undefined ? HOME_PLACE : { taskId: task.id, name: task.title }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

function parseTerminal(value: unknown): TerminalRef | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') {
    return null
  }
  const task = value.task ?? value.taskId
  return {
    id: value.id,
    name: value.name.slice(0, TERMINAL_NAME_MAX),
    task: typeof task === 'string' ? task : null,
  }
}

/**
 * The list a viewer left, or the empty one when nothing usable was stored. It also reads the
 * terminal dock this list replaced: its tabs become terminals, its active tab the recent one.
 */
export function parseList(raw: string | null): TerminalList {
  let value: unknown
  try {
    value = raw === null ? null : JSON.parse(raw)
  } catch {
    return EMPTY_LIST
  }
  if (!isRecord(value)) {
    return EMPTY_LIST
  }
  const stored = Array.isArray(value.terminals) ? value.terminals : value.tabs
  const terminals = (Array.isArray(stored) ? stored : [])
    .map(parseTerminal)
    .filter((terminal): terminal is TerminalRef => terminal !== null)
    .slice(0, LIST_MAX)
  const wanted = value.recent ?? value.active
  const recent = terminals.find((terminal) => terminal.id === wanted)?.id ?? terminals.at(-1)?.id ?? null
  return { terminals, recent }
}

/** `base`, or `base 2` and up when a terminal already has that name. */
export function uniqueName(terminals: readonly Pick<TerminalRef, 'name'>[], base: string): string {
  const names = new Set(terminals.map((terminal) => terminal.name))
  const given = base.trim().slice(0, TERMINAL_NAME_MAX)
  const trimmed = given === '' ? HOME_PLACE.name : given
  if (!names.has(trimmed)) {
    return trimmed
  }
  let n = 2
  while (names.has(`${trimmed} ${String(n)}`)) {
    n += 1
  }
  return `${trimmed} ${String(n)}`
}

/** True while the list has room for one more terminal. */
export const hasRoom = (list: TerminalList) => list.terminals.length < LIST_MAX

/** Adds `terminal`, or keeps the one with its id, and makes it the recent one. */
export function withTerminal(list: TerminalList, terminal: TerminalRef): TerminalList {
  if (list.terminals.some((t) => t.id === terminal.id)) {
    return list.recent === terminal.id ? list : { ...list, recent: terminal.id }
  }
  if (!hasRoom(list)) {
    return list
  }
  return { terminals: [...list.terminals, terminal], recent: terminal.id }
}

/** Drops a terminal; the recent one falls to its neighbour. */
export function withoutTerminal(list: TerminalList, id: string): TerminalList {
  const index = list.terminals.findIndex((terminal) => terminal.id === id)
  if (index === -1) {
    return list
  }
  const terminals = list.terminals.filter((terminal) => terminal.id !== id)
  const neighbour = terminals[Math.min(index, terminals.length - 1)]?.id ?? null
  return { terminals, recent: list.recent === id ? neighbour : list.recent }
}

/** Renames a terminal; a blank name keeps the old one. */
export function renamed(list: TerminalList, id: string, name: string): TerminalList {
  const next = name.trim().slice(0, TERMINAL_NAME_MAX)
  if (next === '' || !list.terminals.some((terminal) => terminal.id === id)) {
    return list
  }
  return { ...list, terminals: list.terminals.map((t) => (t.id === id ? { ...t, name: next } : t)) }
}
