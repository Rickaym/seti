import { Registry, type Disposer, type TerminalRef } from '@seti/shared'
import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { navigate, TERMINAL_ROUTE } from '@/lib/route'
import type { TerminalPlace } from '@/panels/terminal/terminal-list'
import { terminalStore } from '@/panels/terminal/terminal-store'

/** Terminals kept somewhere other than this device's own list, such as a layout's panels. */
export interface TerminalSource {
  /** Unique, such as `<mod>.<name>`. */
  key: string
  /** Shown beside its terminals in the terminal switcher, such as "in a layout". */
  label: string
  /** Its terminals; the same array until they change. */
  list: () => readonly TerminalRef[]
  subscribe: (listener: () => void) => Disposer
  /** Fetches its terminals again, as the switcher and the Terminal button ask before listing. */
  refresh?: () => Promise<void>
  /** Ends the terminal's shell and takes it out of the source. */
  close: (id: string) => void
  rename: (id: string, name: string) => void
}

export const terminalSources = new Registry<TerminalSource>('terminal source', (source) => source.key)

const FULL = 'Seti holds 16 terminals of its own at most; close one to open another'

const sourceOf = (id: string): TerminalSource | undefined =>
  terminalSources.list().find((source) => source.list().some((terminal) => terminal.id === id))

/** Every terminal name in use, this device's and every source's, so a new one is named apart. */
export const takenTerminalNames = (): TerminalRef[] => [
  ...terminalSources.list().flatMap((source) => source.list()),
  ...terminalStore.getSnapshot().terminals,
]

/** Shows terminal `id` alone, the way an agent opens alone. */
export function openTerminalAlone(id: string): void {
  navigate('agents', `${TERMINAL_ROUTE}/${id}`)
}

/** A new terminal of this device's own in `place`, shown alone; false once the list is full. */
export function openNewTerminal(place: TerminalPlace): boolean {
  const terminal = terminalStore.create(place, takenTerminalNames())
  if (terminal === null) {
    toast.error(FULL)
    return false
  }
  openTerminalAlone(terminal.id)
  return true
}

/** Fetches every source's terminals again. */
export async function refreshTerminalSources(): Promise<void> {
  await Promise.all(terminalSources.list().map(async (source) => source.refresh?.()))
}

/** The terminal shown last: this device's recent one, else a source's; null when there is none. */
export function recentTerminal(): string | null {
  const { recent, terminals } = terminalStore.getSnapshot()
  const elsewhere = terminalSources.list().flatMap((source) => source.list())
  return recent ?? terminals.at(-1)?.id ?? elsewhere[0]?.id ?? null
}

/** Ends terminal `id`'s shell, wherever it is kept. */
export function closeTerminal(id: string): void {
  const source = sourceOf(id)
  if (source === undefined) {
    terminalStore.close(id)
  } else {
    source.close(id)
  }
}

/** Renames terminal `id`, wherever it is kept. */
export function renameTerminal(id: string, name: string): void {
  const source = sourceOf(id)
  if (source === undefined) {
    terminalStore.rename(id, name)
  } else {
    source.rename(id, name)
  }
}

/** A terminal, with the label of the source that keeps it, or null for this device's own. */
export interface KnownTerminal {
  terminal: TerminalRef
  label: string | null
}

/** Listens to this device's list, the registry and every registered source. */
function subscribeTerminals(listener: () => void): Disposer {
  let each: Disposer[] = []
  const listen = () => {
    for (const dispose of each) {
      dispose()
    }
    each = terminalSources.list().map((source) => source.subscribe(listener))
  }
  listen()
  const own = terminalStore.subscribe(listener)
  const registry = terminalSources.subscribe(() => {
    listen()
    listener()
  })
  return () => {
    own()
    registry()
    for (const dispose of each) {
      dispose()
    }
  }
}

let cached: { inputs: readonly unknown[]; known: KnownTerminal[] } = { inputs: [], known: [] }

/** This device's terminals and then each source's, the same array until one of them changes. */
export function knownTerminals(): KnownTerminal[] {
  const own = terminalStore.getSnapshot().terminals
  const sources = terminalSources.list()
  const inputs = [own, sources, ...sources.map((source) => source.list())]
  if (inputs.length === cached.inputs.length && inputs.every((input, i) => input === cached.inputs[i])) {
    return cached.known
  }
  const seen = new Set(own.map((terminal) => terminal.id))
  const known: KnownTerminal[] = own.map((terminal) => ({ terminal, label: null }))
  for (const source of sources) {
    for (const terminal of source.list()) {
      if (!seen.has(terminal.id)) {
        seen.add(terminal.id)
        known.push({ terminal, label: source.label })
      }
    }
  }
  cached = { inputs, known }
  return known
}

/** Every terminal to switch to, which a phone lists too, since it shows no layout. */
export const useTerminals = (): KnownTerminal[] => useSyncExternalStore(subscribeTerminals, knownTerminals)

/** True while a source keeps a shell for the agent. */
export const agentHasTerminal = (taskId: string): boolean =>
  terminalSources.list().some((source) => source.list().some((terminal) => terminal.task === taskId))

/** True while a source keeps a shell for the agent, so its Processes badge keeps counting. */
export function useAgentHasTerminal(taskId: string): boolean {
  return useSyncExternalStore(subscribeTerminals, () => agentHasTerminal(taskId))
}
