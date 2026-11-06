interface JsonRpc {
  jsonrpc: '2.0'
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { message: string }
}

/** The MCP transport side of an in-process SDK server, as the Agent SDK drives it. */
interface Transport {
  start: () => Promise<void>
  send: (message: JsonRpc) => Promise<void>
  close: () => Promise<void>
  onmessage?: (message: JsonRpc) => void
  onclose?: () => void
  onerror?: (error: Error) => void
}

export interface SdkServer {
  type: string
  instance?: { connect: (transport: Transport) => Promise<void> }
}

interface ToolResult {
  content?: { type: string; text?: string }[]
  isError?: boolean
}

/** A client for one SDK MCP server, connected in memory the way the real SDK connects it. */
export class InProcessClient {
  private readonly pending = new Map<number, (message: JsonRpc) => void>()
  private nextId = 1
  private readonly transport: Transport = {
    start: async () => Promise.resolve(),
    send: async (message) => {
      if (message.id !== undefined) {
        this.pending.get(message.id)?.(message)
        this.pending.delete(message.id)
      }
      return Promise.resolve()
    },
    close: async () => Promise.resolve(),
  }

  private ready: Promise<void> | null = null
  private readonly server: NonNullable<SdkServer['instance']>

  constructor(server: NonNullable<SdkServer['instance']>) {
    this.server = server
  }

  private async connect(): Promise<void> {
    await this.server.connect(this.transport)
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'fake-claude', version: '1.0.0' },
    })
    this.transport.onmessage?.({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }

  private async request(method: string, params: unknown): Promise<JsonRpc> {
    const id = this.nextId++
    const answer = new Promise<JsonRpc>((resolve) => {
      this.pending.set(id, resolve)
    })
    this.transport.onmessage?.({ jsonrpc: '2.0', id, method, params })
    return answer
  }

  /** The names of the tools the server offers. */
  async tools(): Promise<string[]> {
    this.ready ??= this.connect()
    await this.ready
    const answer = await this.request('tools/list', {})
    const { tools = [] } = (answer.result ?? {}) as { tools?: { name: string }[] }
    return tools.map((entry) => entry.name)
  }

  async call(name: string, args: unknown): Promise<string> {
    this.ready ??= this.connect()
    await this.ready
    const answer = await this.request('tools/call', { name, arguments: args })
    if (answer.error !== undefined) {
      return answer.error.message
    }
    const result = (answer.result ?? {}) as ToolResult
    const text = (result.content ?? []).map((block) => block.text ?? '').join('')
    return result.isError === true ? `Error: ${text}` : text
  }
}
