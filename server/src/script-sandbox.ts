import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { binaryPath } from './binaries.js'

/** bwrap wraps Node's permission model in network, process and mount namespaces. */
export type Isolation = 'bwrap' | 'node'

/** A runner script for a locked-down child, and what else it may read. */
export interface SandboxEntry {
  runner: string
  /** Files or folders the runner reads besides itself: bound read-only and granted to Node. */
  reads?: readonly string[]
  /** Arguments after the runner's path, such as its settings as JSON. */
  args?: readonly string[]
}

const NODE_PREFIX = path.dirname(path.dirname(process.execPath))

/** Node's permission model granting only the reads: no other files, processes or addons. */
export const nodeArgs = (heapMb: number, reads: readonly string[] = []): string[] => [
  '--permission',
  ...reads.map((entry) => `--allow-fs-read=${entry}`),
  `--max-old-space-size=${String(heapMb)}`,
  '--max-semi-space-size=2',
  '--no-warnings',
]

/** No network, no other processes and no writable mounts; /home, /run and /tmp are empty. */
function bwrapArgs(binds: readonly string[]): string[] {
  const mounts = [
    ['--ro-bind', '/', '/'],
    ['--dev', '/dev'],
    ['--proc', '/proc'],
    ['--tmpfs', '/tmp'],
    ['--tmpfs', '/run'],
    ['--tmpfs', '/home'],
    ['--ro-bind', NODE_PREFIX, NODE_PREFIX],
    ...binds.map((bind) => ['--ro-bind', bind, bind]),
  ]
  return [
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--cap-drop',
    'ALL',
    ...mounts.flat(),
    '--clearenv',
    '--chdir',
    '/',
  ]
}

interface Detected {
  isolation: Isolation
  bwrap: string | null
  reason: string | null
}

let detected: Detected | null = null

function detect(): Detected {
  const bwrap = binaryPath('bwrap')
  if (bwrap === null) {
    return { isolation: 'node', bwrap: null, reason: 'bwrap is not installed' }
  }
  const probe = spawnSync(bwrap, [...bwrapArgs([]), process.execPath, '--version'], { timeout: 15_000, env: {} })
  if (probe.status === 0) {
    return { isolation: 'bwrap', bwrap, reason: null }
  }
  const why = probe.error?.message ?? probe.stderr.toString().trim()
  return { isolation: 'node', bwrap: null, reason: `bwrap cannot start a sandbox here: ${why}` }
}

/** How scripts are isolated on this host, checked once; Seti logs why when bwrap is out. */
export function isolation(): Detected {
  if (detected === null) {
    detected = detect()
    if (detected.reason !== null) {
      process.stderr.write(`scripts: reminders and mods run without network isolation; ${detected.reason}\n`)
    }
  }
  return detected
}

/** The program and arguments that start the runner locked down, in bwrap when asked and present. */
export function sandboxCommand(entry: SandboxEntry, heapMb: number, use: Isolation): { file: string; args: string[] } {
  const reads = entry.reads ?? []
  const node = [...nodeArgs(heapMb, reads), entry.runner, ...(entry.args ?? [])]
  const { bwrap } = isolation()
  if (use === 'bwrap' && bwrap !== null) {
    return { file: bwrap, args: [...bwrapArgs([entry.runner, ...reads]), process.execPath, ...node] }
  }
  return { file: process.execPath, args: node }
}

/** Resident memory of a process and every process under it, in bytes. */
export function treeRss(pid: number): number {
  try {
    const status = fs.readFileSync(`/proc/${String(pid)}/status`, 'utf8')
    const own = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) * 1024
    const children = fs.readFileSync(`/proc/${String(pid)}/task/${String(pid)}/children`, 'utf8')
    return children
      .split(/\s+/)
      .filter((entry) => entry !== '')
      .reduce((total, child) => total + treeRss(Number(child)), own)
  } catch {
    return 0
  }
}
