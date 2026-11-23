import fs from 'node:fs'
import path from 'node:path'
import type { ToolCall, ToolKind } from '@seti/shared'
import { readOnly } from '../policy/read-only.js'
import { credentialFindings } from '../scrub.js'
import { asText, MEMORY_CAP } from './memory-files.js'

/** The tool server a dream reports through, and its one tool. */
export const DREAM_SERVER = 'dream'
export const DREAM_REPORT = 'dream_report'

/** Where a dream works, as its sandbox shows the paths. */
export interface DreamPlaces {
  cwd: string
  home: string
  /** Every folder the dream may read: its working folders, workspace and memory folders. */
  readable: readonly string[]
  /** The agent's own memory folder, which the dream may write. */
  memory: string
  /** The night's dream folder, which the dream may write. */
  night: string
}

/** A refusal the model can act on, or null to let the call run. */
export type GateAnswer = string | null

const inside = (child: string, parent: string) => child === parent || child.startsWith(`${parent}/`)

/** Git subcommands that only read, which the workspace review uses; any flag but an output one. */
const GIT_READS = /^(status|log|diff|show|rev-parse|branch|for-each-ref|worktree list|stash list|remote)\b/
const PLAIN_WORD = /^[\w./@:=+,%-]+$/

/** `git [-C <folder>] <read subcommand> ...` with plain words and a folder the dream may read. */
function gitRead(command: string, places: DreamPlaces): boolean {
  const words = command.trim().split(/\s+/)
  if (words[0] !== 'git' || !words.every((word) => PLAIN_WORD.test(word))) {
    return false
  }
  let rest = words.slice(1)
  if (rest[0] === '-C') {
    const dir = path.resolve(places.cwd, rest[1] ?? '')
    if (!places.readable.some((root) => inside(dir, root))) {
      return false
    }
    rest = rest.slice(2)
  }
  const line = rest.join(' ')
  const changes =
    /^(branch|remote|stash list|worktree list)\b/.test(line) && /\s-[dDmMcC]\b|\s--(delete|move|copy)\b/.test(line)
  return GIT_READS.test(line) && !changes && !rest.some((word) => /^--(output|ext-diff|textconv|no-index)/.test(word))
}

function shellAnswer(call: ToolCall, places: DreamPlaces): GateAnswer {
  const command = call.shell?.action === 'run' ? (call.shell.command ?? '') : ''
  const context = {
    mode: 'ask' as const,
    rules: [],
    cwd: places.cwd,
    dirs: places.readable,
    home: places.home,
    classifier: false,
  }
  if (command !== '' && (readOnly(command, context) || gitRead(command, places))) {
    return null
  }
  return 'A dream runs only commands that read: ls, cat, head, tail, wc, stat, du, diff, grep, find without actions, and git status, log, diff, show, branch, worktree list and stash list. Read files with Read, Glob and Grep, and write memory with Write or Edit.'
}

/** Bytes and files the memory folder holds now, as the host sees it. */
function folderSize(dir: string): { bytes: number; files: number } {
  let bytes = 0
  let files = 0
  const walk = (at: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        files += 1
        bytes += fs.statSync(full).size
      }
    }
  }
  if (fs.existsSync(dir)) {
    walk(dir)
  }
  return { bytes, files }
}

/** The text a change puts in place, and the size it adds at most. */
function growth(change: NonNullable<ToolCall['edit']>['changes'][number], current: number): number {
  const after = Buffer.byteLength(change.after ?? '')
  return change.op === 'write' ? after - current : Math.max(0, after - Buffer.byteLength(change.before ?? ''))
}

interface Change {
  file: string
  change: NonNullable<ToolCall['edit']>['changes'][number]
}

/** Why one file change is refused, or null; the memory folder is checked on the host. */
function changeAnswer({ file, change }: Change, places: DreamPlaces, hostMemory: string): GateAnswer {
  const inMemory = inside(file, places.memory)
  if (!inMemory && !inside(file, places.night)) {
    return `A dream writes only its memory folder, ${places.memory}. Everything else is read-only; put what matters in the report.`
  }
  if (
    path
      .relative(inMemory ? places.memory : places.night, file)
      .split('/')
      .some((part) => part.startsWith('.'))
  ) {
    return 'A dream does not write hidden files or folders.'
  }
  if (credentialFindings(change.after ?? '').length > 0) {
    return 'That text holds a credential. Memory never keeps credentials: leave the value out and say where it lives instead.'
  }
  return inMemory ? memoryAnswer(path.join(hostMemory, path.relative(places.memory, file)), change, hostMemory) : null
}

/** Why a change to a memory file is refused: a file that is not text, or the folder's limit. */
function memoryAnswer(host: string, change: Change['change'], hostMemory: string): GateAnswer {
  const existing = fs.existsSync(host) ? fs.readFileSync(host) : null
  if (existing !== null && asText(existing) === null) {
    return 'That file is not text; a dream changes only text files.'
  }
  const now = folderSize(hostMemory)
  const files = now.files + (existing === null ? 1 : 0)
  if (now.bytes + growth(change, existing?.length ?? 0) > MEMORY_CAP.bytes || files > MEMORY_CAP.files) {
    return `The memory folder would pass its limit of ${String(MEMORY_CAP.bytes / 1024)} KB or ${String(MEMORY_CAP.files)} files. Merge and shorten instead.`
  }
  return null
}

function editAnswer(call: ToolCall, places: DreamPlaces, hostMemory: string): GateAnswer {
  const changes = call.edit?.changes ?? []
  if (changes.length === 0) {
    return 'That edit names no file.'
  }
  for (const change of changes) {
    const file = path.resolve(places.cwd, change.path)
    const answer =
      change.op === 'write' || change.op === 'update'
        ? changeAnswer({ file, change }, places, hostMemory)
        : 'A dream does not delete or move files.'
    if (answer !== null) {
      return answer
    }
  }
  return null
}

type Decide = (call: ToolCall, places: DreamPlaces, hostMemory: string) => GateAnswer

/** The kinds of call a dream may make; every other kind is refused. */
const BY_KIND: Partial<Record<ToolKind, Decide>> = {
  read: () => null,
  search: (call) => (call.search?.tools === true ? 'A dream has no tools to search for.' : null),
  edit: editAnswer,
  shell: (call, places) => shellAnswer(call, places),
  mcp: (call) =>
    call.mcp?.server === DREAM_SERVER && call.mcp.tool === DREAM_REPORT
      ? null
      : 'A dream has no tool servers but its report.',
}

/**
 * Decides a dream's tool call by itself, whatever any other check says: reads anywhere the
 * sandbox shows, writes only inside the memory and night folders and without a credential or
 * past the memory limit, shell lines that only read, and the report; nothing else.
 */
export function dreamGate(call: ToolCall, places: DreamPlaces, hostMemory: string): GateAnswer {
  const decide = BY_KIND[call.kind]
  return decide === undefined
    ? `A dream cannot use ${call.name}: it reads, writes its memory folder and reports, and nothing else.`
    : decide(call, places, hostMemory)
}
