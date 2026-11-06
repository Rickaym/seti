import { z } from 'zod'

const MB_MAX = 1024 * 1024
const CAP_MIN_MB = 256

/**
 * Memory limits of one agent's process tree, in MiB: the kernel stops a process of it above
 * `max_mb` and swaps out up to `swap_max_mb`; a `high_mb` below the cap throttles it there.
 */
export const memoryCapInput = z
  .object({
    high_mb: z.number().int().min(CAP_MIN_MB, 'at least 256 MB').max(MB_MAX),
    max_mb: z.number().int().min(CAP_MIN_MB, 'at least 256 MB').max(MB_MAX),
    swap_max_mb: z.number().int().min(0).max(MB_MAX),
  })
  .refine((cap) => cap.high_mb <= cap.max_mb, {
    message: 'The soft cap cannot be above the RAM cap',
    path: ['high_mb'],
  })

export type MemoryCap = z.infer<typeof memoryCapInput>

/** No throttle point by default: on a host with full swap a throttled process stalls instead. */
export const MEMORY_CAP_DEFAULTS: MemoryCap = { high_mb: 6144, max_mb: 6144, swap_max_mb: 1024 }

export const throttles = (cap: MemoryCap) => cap.high_mb < cap.max_mb

/** A cap of its own for one agent, or null to go back to the default. */
export const taskMemoryCapInput = z.object({ cap: memoryCapInput.nullable() })
export type TaskMemoryCapInput = z.input<typeof taskMemoryCapInput>

export interface MemoryCapSettings {
  cap: MemoryCap
  defaults: MemoryCap
  /** This host runs agents in systemd scopes that hold them to the cap. */
  enforced: boolean
  /** Null while the defaults apply. */
  updated_at: string | null
}

export interface TaskMemoryCap {
  /** Null when the agent takes the default cap. */
  override: MemoryCap | null
  effective: MemoryCap
  enforced: boolean
}

/** What a memory note in a transcript is about: a process stopped at the cap, or throttling. */
export const MEMORY_EVENTS = ['oom_kill', 'high'] as const
export type MemoryEvent = (typeof MEMORY_EVENTS)[number]

/** A size in MiB as people read it: 6 GB, 1.5 GB, 512 MB. */
export function mbLabel(mb: number): string {
  if (mb < 1024) {
    return `${String(mb)} MB`
  }
  return `${String(Math.round((mb / 1024) * 10) / 10)} GB`
}

/** A cap in one line: 6 GB RAM, 1 GB swap, and the soft cap when it has one. */
export function capLabel(cap: MemoryCap): string {
  const soft = throttles(cap) ? `, soft cap at ${mbLabel(cap.high_mb)}` : ''
  return `${mbLabel(cap.max_mb)} RAM${soft}, ${mbLabel(cap.swap_max_mb)} swap`
}

/** What an OOM kill stopped, as far as Seti could tell. */
export interface OomVictims {
  /** The scope's own process: Claude Code for an agent, the command itself for a shell run. */
  root: boolean
  /** The other processes stopped, by program name. */
  names: string[]
}

/** One memory event of a scope: an agent, its side chat, a `!` command or a terminal. */
export interface MemoryReport {
  event: MemoryEvent
  cap: MemoryCap
  kind: 'agent' | 'side_chat' | 'shell' | 'terminal'
  /** Null when Seti could not tell which processes an OOM kill stopped. */
  victims: OomVictims | null
}

/** Names in a sentence: tsc, eslint and chrome. */
function nameList(names: readonly string[]): string {
  if (names.length <= 1) {
    return names.join('')
  }
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`
}

const SCOPE_OWNERS: Record<MemoryReport['kind'], string> = {
  agent: "the agent's",
  side_chat: "the side chat's",
  shell: "the shell command's",
  terminal: "the terminal's",
}

const SCOPE_ROOTS: Record<MemoryReport['kind'], string> = {
  agent: 'Claude Code',
  side_chat: 'Claude Code',
  shell: 'The shell command',
  terminal: 'The terminal shell',
}

/** The transcript note for a memory event, naming what was stopped and whether the turn ended. */
export function memoryNote({ event, cap, kind, victims }: MemoryReport): string {
  if (event === 'high') {
    return `Went over ${mbLabel(cap.high_mb)} of memory; the system is slowing it down until it uses less`
  }
  const limit = `process tree hit its ${mbLabel(cap.max_mb)} memory cap`
  const owner = SCOPE_OWNERS[kind]
  const root = victims?.root === true ? [SCOPE_ROOTS[kind]] : []
  const stopped = [...new Set([...root, ...(victims?.names ?? [])])]
  if (stopped.length === 0) {
    return `A process was stopped: ${owner} ${limit}`
  }
  const alone = stopped.length === 1
  const ended = root.length > 0 && kind === 'agent' ? '; the turn ended' : ''
  return `${nameList(stopped)} ${alone ? 'was' : 'were'} stopped: ${alone && root.length > 0 ? 'its' : owner} ${limit}${ended}`
}

/** One line for the agent's system prompt: its cap, and how to keep tools inside it. */
export function memoryBudgetLine(cap: MemoryCap, heapMb: number): string {
  return (
    `Your process tree has a ${mbLabel(cap.max_mb)} memory cap. Keep Node heaps (--max-old-space-size) ` +
    `under about ${mbLabel(heapMb)}, run one tsc or build at a time, and prefer incremental or ` +
    'per-package type checks. At the cap the kernel stops your largest tool process first.'
  )
}
