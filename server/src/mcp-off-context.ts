import type { CapabilitiesSnapshot, SetiControlLevel } from '@seti/shared'
import { capabilityCache } from './capabilities.js'
import { tasks } from './db.js'
import { taskMcpServers } from './mcp-selection.js'

/** Servers the block names; the rest are counted, so the block stays short on every turn. */
const LIST_MAX = 8
const HINT_WORDS = 3
/** A name the block spells out: plain characters only, so nothing like a URL or a token shows. */
const PLAIN_NAME = /^[\w .:@-]{1,60}$/

/** The prefix Claude Code gives a server's tools, with every other character of its name as _. */
export const mcpToolPrefix = (server: string): string => `mcp__${server.replace(/[^\w-]/g, '_')}__`

/** The tool names of a server from the first probe that listed any; none when never connected. */
export function probedTools(server: string, snapshots: readonly CapabilitiesSnapshot[] = capabilityCache.all()) {
  for (const snapshot of snapshots) {
    const tools = snapshot.servers.find((entry) => entry.name === server)?.tools ?? []
    if (tools.length > 0) {
      return tools.map((tool) => tool.name)
    }
  }
  return []
}

const singular = (word: string) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word)

/** What a tool name is about: its words after the verb, without the words every tool shares. */
function subjects(tool: string, shared: ReadonlySet<string>): string[] {
  const words = tool
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '' && !shared.has(word))
  return (words.length > 1 ? words.slice(1) : words).map(singular)
}

/** A few words on what a server is for: the subjects its tool names mention most. */
export function toolHint(tools: readonly string[]): string | null {
  const split = tools.map((tool) => new Set(tool.toLowerCase().split(/[^a-z0-9]+/)))
  const [first] = split
  const shared = new Set(
    first === undefined || split.length < 2 ? [] : [...first].filter((word) => split.every((set) => set.has(word))),
  )
  const counts = new Map<string, number>()
  for (const word of tools.flatMap((tool) => subjects(tool, shared))) {
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  const top = [...counts].toSorted((a, b) => b[1] - a[1]).slice(0, HINT_WORDS)
  return top.length === 0 ? null : top.map(([word]) => word).join(', ')
}

/** How the agent gets one: its own request, or the user when it has no request_change. */
const HOW: Record<SetiControlLevel, string> = {
  off: 'The user can turn one on in your access.',
  self: 'Ask for one by this exact name with request_change, kind mcp_server.',
  full: 'Ask for one by this exact name with request_change, kind mcp_server.',
}

export interface OffServer {
  name: string
  tools: readonly string[]
}

/** The block for the servers that are off, or null when none is; names and tool words only. */
export function offServersText(servers: readonly OffServer[], level: SetiControlLevel): string | null {
  if (servers.length === 0) {
    return null
  }
  const plain = servers.filter((server) => PLAIN_NAME.test(server.name))
  const listed = plain.slice(0, LIST_MAX).map((server) => {
    const hint = toolHint(server.tools)
    return hint === null ? server.name : `${server.name} (${hint})`
  })
  const more = servers.length - listed.length
  const rest =
    more === 0 ? [] : [`${listed.length === 0 ? '' : 'and '}${String(more)} more that list_mcp_servers names`]
  return `MCP servers on this install that are off for you: ${[...listed, ...rest].join(', ')}. ${HOW[level]}`
}

/** Tells an agent which MCP servers it could have, so it asks by name instead of searching. */
export async function mcpOffContext(taskId: string): Promise<string | null> {
  const task = await tasks.get(taskId)
  if (task === undefined) {
    return null
  }
  const off = (await taskMcpServers(taskId, false)).filter((server) => !server.enabled)
  return offServersText(
    off.map((server) => ({ name: server.name, tools: probedTools(server.name) })),
    task.seti_control,
  )
}
