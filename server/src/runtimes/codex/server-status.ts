import { z } from 'zod'
import type { ToolServerState } from '../adapter.js'
import type { RpcCall } from '../json-rpc.js'

const startupNote = z.looseObject({
  name: z.string(),
  status: z.string(),
  error: z.string().nullish(),
  failureReason: z.string().nullish(),
})

/** Codex's startup states in the words Seti's MCP status uses. */
const STATUS: Partial<Record<string, string>> = {
  starting: 'pending',
  ready: 'connected',
  failed: 'failed',
  cancelled: 'failed',
}

/** A server's start or address setting on the app-server's command line names it. */
const SERVER_SETTING = /^mcp_servers\.([A-Za-z0-9_-]+)\.(command|url)=/

/** How each of a Codex session's tool servers started, as Codex reported it. */
export class ServerStatus {
  private readonly servers = new Map<string, ToolServerState>()

  /** Every server the command line starts is pending until Codex reports it. */
  constructor(args: readonly string[]) {
    for (const arg of args) {
      const [, name, setting] = SERVER_SETTING.exec(arg) ?? []
      if (name !== undefined) {
        this.servers.set(name, { name, status: 'pending', transport: setting === 'url' ? 'http' : 'stdio' })
      }
    }
  }

  /** Takes in one startup report; any other message is left alone. */
  note(message: RpcCall): void {
    if (message.method !== 'mcpServer/startupStatus/updated') {
      return
    }
    const note = startupNote.safeParse(message.params).data
    if (note === undefined) {
      return
    }
    const status = note.failureReason === 'reauthenticationRequired' ? 'needs-auth' : (STATUS[note.status] ?? 'failed')
    const error = note.error ?? undefined
    const transport = this.servers.get(note.name)?.transport ?? null
    this.servers.set(note.name, { name: note.name, status, transport, ...(error === undefined ? {} : { error }) })
  }

  /** The servers reported so far, by name. */
  list(): ToolServerState[] {
    return [...this.servers.values()].toSorted((a, b) => a.name.localeCompare(b.name, 'en'))
  }
}
