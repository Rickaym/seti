import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mcpEnabled, type Task } from '@seti/shared'
import { hostClaudeJson } from './sandbox-mcp.js'
import { canonicalRoot } from './sandbox-mounts.js'
import { mcpDefaults, taskMcpChoices } from './store/mcp.js'

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The host's Claude Code config, with its user and per-directory local MCP servers. */
export function readHostConfig(file: string = hostClaudeJson()): Json {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return isObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const serversOf = (entry: unknown): Json => (isObject(entry) && isObject(entry.mcpServers) ? entry.mcpServers : {})

const projectsOf = (host: Json): Json => (isObject(host.projects) ? host.projects : {})

/** The config keys Claude Code reads local MCP servers from for a directory: it and its repo. */
export const ownProjects = (cwd: string): string[] => [...new Set([cwd, canonicalRoot(cwd) ?? cwd])]

/** Servers only the local config of some directories has, with those directories in order. */
export function localServers(host: Json): Map<string, string[]> {
  const user = serversOf(host)
  const projects = projectsOf(host)
  const local = new Map<string, string[]>()
  for (const dir of Object.keys(projects).toSorted((a, b) => a.localeCompare(b, 'en'))) {
    for (const name of Object.keys(serversOf(projects[dir]))) {
      if (!(name in user)) {
        local.set(name, [...(local.get(name) ?? []), dir])
      }
    }
  }
  return local
}

/** Whether a server is local to other directories than `own`; any local server when own is null. */
export const isBorrowed = (local: ReadonlyMap<string, readonly string[]>, own: readonly string[] | null) => {
  return (name: string) => {
    const dirs = local.get(name)
    return dirs !== undefined && (own === null || !dirs.some((dir) => own.includes(dir)))
  }
}

/** A directory as the user writes it, with ~ for the home directory. */
export function tilde(dir: string, home = os.homedir()): string {
  return dir === home || dir.startsWith(`${home}${path.sep}`) ? `~${dir.slice(home.length)}` : dir
}

/** Local servers of other directories that a session in `own` lacks; per name the first wins. */
export function borrowedServers(host: Json, own: readonly string[], enabled: (name: string) => boolean): Json {
  const projects = projectsOf(host)
  const borrowed: Json = {}
  for (const [name, dirs] of localServers(host)) {
    const [first] = dirs
    if (first !== undefined && !dirs.some((dir) => own.includes(dir)) && enabled(name)) {
      borrowed[name] = serversOf(projects[first])[name]
    }
  }
  return borrowed
}

/** The servers of other directories a task turns on, which its session gets from Seti. */
export async function taskBorrowedServers(task: Pick<Task, 'id' | 'cwd'>, host = readHostConfig()): Promise<Json> {
  const [defaults, choices] = await Promise.all([mcpDefaults.all(), taskMcpChoices.get(task.id)])
  return borrowedServers(host, ownProjects(task.cwd), (name) => mcpEnabled(name, defaults, choices, false))
}

/** The directory whose config gives a task's session the server: its own, or the one lending it. */
export async function serverDir(task: Pick<Task, 'id' | 'cwd'>, name: string, host = readHostConfig()) {
  const lent = name in (await taskBorrowedServers(task, host)) ? localServers(host).get(name)?.[0] : undefined
  return lent ?? task.cwd
}

/** Names and a digest of the config, so a setup key changes with it without holding its keys. */
export const borrowedStamp = (servers: Json) => ({
  names: Object.keys(servers),
  digest: createHash('sha256').update(JSON.stringify(servers)).digest('hex').slice(0, 16),
})
