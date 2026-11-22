import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** What a prompt asks for to get the MCP servers the session loaded as the reply. */
export const SERVERS_PROMPT = 'which mcp servers do you have'
/** The update Seti hands an agent once the user turned a server on, which makes it look again. */
const TURNED_ON = 'turned on the MCP server'
/** How the reply starts; the names follow in brackets. */
export const SERVERS_REPLY = 'Loaded MCP servers:'

export const asksForServers = (prompt: string) => prompt.includes(SERVERS_PROMPT) || prompt.includes(TURNED_ON)

/** The session's settings as far as this fake reads them: the servers Seti leaves out. */
export interface FakeSettings {
  deniedMcpServers?: { serverName: string }[]
}

/** The user's configured servers without those the session's settings deny, as Claude Code loads. */
export function loadedServers(settings: FakeSettings | undefined): string {
  const file = path.join(os.homedir(), '.claude.json')
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown> }
  const denied = new Set((settings?.deniedMcpServers ?? []).map((entry) => entry.serverName))
  const names = Object.keys(config.mcpServers ?? {}).filter((name) => !denied.has(name))
  return `${SERVERS_REPLY} [${names.toSorted((a, b) => a.localeCompare(b, 'en')).join(', ')}]`
}
