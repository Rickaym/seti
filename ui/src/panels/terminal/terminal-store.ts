import type { TerminalRef } from '@seti/shared'
import { useSyncExternalStore } from 'react'
import { shellStarts, stopShell } from './shells'
import {
  hasRoom,
  parseList,
  renamed,
  uniqueName,
  withoutTerminal,
  withTerminal,
  type TerminalList,
  type TerminalPlace,
} from './terminal-list'

const STORAGE_KEY = 'seti.terminals'

/** The bottom dock's tabs, read once so its shells carry over as terminals of their own. */
const DOCK_KEY = 'seti.terminal.dock'

function save(list: TerminalList): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
    localStorage.removeItem(DOCK_KEY)
  } catch {
    // Storage can be blocked; the list then lasts for this visit only.
  }
}

function load(): TerminalList {
  try {
    const own = localStorage.getItem(STORAGE_KEY)
    if (own !== null) {
      return parseList(own)
    }
    const dock = localStorage.getItem(DOCK_KEY)
    const list = parseList(dock)
    if (dock !== null) {
      save(list)
    }
    return list
  } catch {
    return parseList(null)
  }
}

/** A terminal for a new shell in `place`, named apart from `taken`; it starts once shown. */
export function mintTerminal(place: TerminalPlace, taken: readonly Pick<TerminalRef, 'name'>[]): TerminalRef {
  const terminal = { id: crypto.randomUUID(), name: uniqueName(taken, place.name), task: place.taskId }
  shellStarts.allow(terminal.id)
  return terminal
}

let state: TerminalList = load()
const listeners = new Set<() => void>()

function set(next: TerminalList): void {
  if (next === state) {
    return
  }
  state = next
  save(next)
  for (const listener of listeners) {
    listener()
  }
}

/** This device's own terminals, kept across reloads; their shells run on. */
export const terminalStore = {
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  getSnapshot: () => state,
  /** A terminal for a new shell in `place`, named apart from `taken`; null once the list is full. */
  create: (place: TerminalPlace, taken: readonly Pick<TerminalRef, 'name'>[]): TerminalRef | null => {
    if (!hasRoom(state)) {
      return null
    }
    const terminal = mintTerminal(place, taken)
    set(withTerminal(state, terminal))
    return terminal
  },
  /** Takes a terminal in from elsewhere, such as a layout; false once the list is full. */
  adopt: (terminal: TerminalRef): boolean => {
    const next = withTerminal(state, terminal)
    set(next)
    return next.terminals.some((t) => t.id === terminal.id)
  },
  /** Takes a terminal out to show it elsewhere; its shell keeps running. */
  release: (id: string) => {
    set(withoutTerminal(state, id))
  },
  /** Ends the terminal's shell and forgets it. */
  close: (id: string) => {
    set(withoutTerminal(state, id))
    void stopShell(id)
  },
  rename: (id: string, name: string) => {
    set(renamed(state, id, name))
  },
  /** Counts the terminal as the one shown last. */
  touch: (id: string) => {
    if (state.recent !== id && state.terminals.some((terminal) => terminal.id === id)) {
      set({ ...state, recent: id })
    }
  },
}

export const useTerminalList = (): TerminalList =>
  useSyncExternalStore(terminalStore.subscribe, terminalStore.getSnapshot)
