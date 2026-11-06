import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CapabilitiesSnapshot, McpServer } from '@seti/shared'
import { audit } from './audit.js'
import { inBackground } from './background.js'
import { capabilityCache } from './capabilities.js'
import { ownProjects } from './mcp-borrowed.js'
import { hostClaudeJson } from './sandbox-mcp.js'
import { forgetMcpChoices, mcpConfigDirs, storedMcpNames } from './store/mcp.js'
import { signalWorkspaces } from './workspace/dir.js'

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

const serverNames = (entry: unknown): string[] =>
  isObject(entry) && isObject(entry.mcpServers) ? Object.keys(entry.mcpServers) : []

/** The server names in Claude Code's MCP config files, and whether every one of them was read. */
export interface McpConfigRead {
  names: ReadonlySet<string>
  complete: boolean
}

/** Where to look: the host's ~/.claude.json, repo checkouts and the directories agents run in. */
export interface McpConfigSources {
  hostFile: string
  /** A missing checkout leaves the read incomplete, since it may be back soon. */
  repos: readonly string[]
  /** A missing directory is skipped: worktrees of finished agents come and go. */
  agents: readonly string[]
}

type JsonRead = { ok: true; value: unknown } | { ok: false }

function readJson(file: string, missing: JsonRead): JsonRead {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch (e) {
    return (e as { code?: unknown }).code === 'ENOENT' ? missing : { ok: false }
  }
}

/** Reads every MCP config file Seti knows of; a file that exists but fails to parse is incomplete. */
export function readMcpConfigs(sources: McpConfigSources): McpConfigRead {
  const names = new Set<string>()
  let complete = true
  const host = readJson(sources.hostFile, { ok: false })
  if (host.ok && isObject(host.value)) {
    serverNames(host.value).forEach((name) => names.add(name))
    const projects = isObject(host.value.projects) ? Object.values(host.value.projects) : []
    projects.flatMap(serverNames).forEach((name) => names.add(name))
  } else {
    complete = false
  }
  const repos = new Set(sources.repos)
  const dirs = new Set([...sources.repos, ...sources.agents])
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      complete &&= !repos.has(dir)
      continue
    }
    for (const root of ownProjects(dir)) {
      const project = readJson(path.join(root, '.mcp.json'), { ok: true, value: {} })
      if (project.ok && isObject(project.value)) {
        serverNames(project.value).forEach((name) => names.add(name))
      } else {
        complete = false
      }
    }
  }
  return { names, complete }
}

const FILE_SCOPES: ReadonlySet<string> = new Set(['user', 'project', 'local'])

const pluginOf = (name: string): string | null => (name.startsWith('plugin:') ? (name.split(':')[1] ?? '') : null)

const isConnector = (server: McpServer) =>
  server.transport?.type === 'claudeai-proxy' || server.scope === 'claudeai' || server.name.startsWith('claude.ai ')

/**
 * Whether a server is gone from everywhere Seti reads. A config file server is gone when a
 * complete read lacks it. A plugin or claude.ai server is gone when the newest probe that loaded
 * its plugin, or any connector, lacks it, and stays while none did. Other probed servers stay.
 */
export function goneServers(config: McpConfigRead, snapshots: readonly CapabilitiesSnapshot[]) {
  const newestFirst = snapshots.toSorted((a, b) => b.probed_at.localeCompare(a.probed_at))
  const probed = newestFirst.flatMap((snapshot) => snapshot.servers)
  const connectors = new Set(probed.filter(isConnector).map((server) => server.name))
  const elsewhere = new Set(
    probed
      .filter((server) => server.source === 'plugin' || (server.scope !== null && !FILE_SCOPES.has(server.scope)))
      .map((server) => server.name),
  )
  const missingFromNewest = (loads: (server: McpServer) => boolean, name: string) => {
    const newest = newestFirst.find((snapshot) => snapshot.servers.some(loads))
    return newest !== undefined && !newest.servers.some((server) => server.name === name)
  }
  return (name: string): boolean => {
    if (config.names.has(name)) {
      return false
    }
    const plugin = pluginOf(name)
    if (plugin !== null) {
      return missingFromNewest((server) => pluginOf(server.name) === plugin, name)
    }
    if (name.startsWith('claude.ai ') || connectors.has(name)) {
      return missingFromNewest(isConnector, name)
    }
    return !elsewhere.has(name) && config.complete
  }
}

async function currentConfigs(): Promise<McpConfigRead> {
  const dirs = await mcpConfigDirs()
  const probed = capabilityCache.all().map((snapshot) => snapshot.cwd)
  return readMcpConfigs({
    hostFile: hostClaudeJson(),
    repos: dirs.repos,
    agents: [...dirs.agents, ...probed, os.homedir()],
  })
}

/** Whether a server is gone, read fresh from the config files and this process's probes. */
export async function mcpGone(): Promise<(name: string) => boolean> {
  return goneServers(await currentConfigs(), capabilityCache.all())
}

/** A probe without the servers since gone from every config, for a snapshot that may be old. */
export async function withoutGoneServers(snapshot: CapabilitiesSnapshot): Promise<CapabilitiesSnapshot> {
  const gone = await mcpGone()
  return { ...snapshot, servers: snapshot.servers.filter((server) => !gone(server.name)) }
}

async function forget(names: readonly string[], why: string): Promise<string[]> {
  if (names.length === 0) {
    return []
  }
  await forgetMcpChoices(names)
  await audit.record({
    actor: 'system',
    kind: 'mcp.choices_forgotten',
    subject_type: 'mcp_server',
    subject_id: names.length === 1 ? (names[0] ?? null) : null,
    summary: `Forgot the defaults and agent choices of ${why}: ${names.join(', ')}`,
    detail: { servers: [...names] },
  })
  signalWorkspaces('task')
  return [...names]
}

let pruning: Promise<string[]> = Promise.resolve([])

/** Drops the stored choices of servers gone from every config, one pass at a time. */
export async function forgetGoneMcpServers(): Promise<string[]> {
  const next = pruning
    .catch(() => [])
    .then(async () => {
      const gone = await mcpGone()
      return forget((await storedMcpNames()).filter(gone), 'MCP servers no longer configured')
    })
  pruning = next
  return next
}

/** After Seti removes a server: drops its choices unless a config file still names it. */
export async function forgetRemovedMcpServer(name: string): Promise<string[]> {
  const stored = await storedMcpNames()
  if (!stored.includes(name) || (await currentConfigs()).names.has(name)) {
    return []
  }
  return forget([name], 'removed MCP server')
}

/** Starts a pass nobody waits for, such as after a probe; shutdown waits for it. */
export function forgetGoneServersLater(): void {
  inBackground('forgetting gone MCP servers', forgetGoneMcpServers)
}
