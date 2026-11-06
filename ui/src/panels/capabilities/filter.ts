import type { CommandGroup, CommandInfo, McpServer, McpTool } from '@seti/shared'

export const normalize = (query: string) => query.trim().toLowerCase()

export const matches = (query: string, ...texts: string[]) =>
  query === '' || texts.some((text) => text.toLowerCase().includes(query))

export interface ServerView {
  server: McpServer
  tools: McpTool[]
  toolHit: boolean
}

/** A server shows all its tools when its name matches, otherwise only the matching tools. */
export function filterServers(servers: McpServer[], query: string): ServerView[] {
  return servers.flatMap((server): ServerView[] => {
    if (matches(query, server.name, server.transport?.target ?? '')) {
      return [{ server, tools: server.tools, toolHit: false }]
    }
    const tools = server.tools.filter((tool) => matches(query, tool.name, tool.description))
    return tools.length > 0 ? [{ server, tools, toolHit: true }] : []
  })
}

export const filterCommands = (commands: CommandInfo[], query: string) =>
  commands.filter((command) => matches(query, command.name, command.description, ...command.aliases))

export const filterGroups = (groups: CommandGroup[], query: string): CommandGroup[] =>
  groups
    .map((group) => ({ prefix: group.prefix, commands: filterCommands(group.commands, query) }))
    .filter((group) => group.commands.length > 0)
