import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { playTurn, type Act, type CanUseTool } from './turns.js'

type Message = Record<string, unknown> & { type: string }

interface UserMessage {
  message: { content: string | { type: string; text?: string }[] }
}

interface Options {
  canUseTool?: CanUseTool
  cwd?: string
  resume?: string
}

/** How long the scripted agent takes between steps, so a turn plays out like a real one. */
const STEP_MS = 700

const textOf = (m: UserMessage) =>
  typeof m.message.content === 'string'
    ? m.message.content
    : m.message.content.map((block) => block.text ?? '').join('')

/** Hands messages to the one reader, waiting while there are none. */
class Outbox {
  private readonly items: Message[] = []
  private wake: (() => void) | null = null
  ended = false

  push(m: Message): void {
    this.items.push(m)
    this.poke()
  }

  end(): void {
    this.ended = true
    this.poke()
  }

  async *drain(): AsyncGenerator<Message> {
    for (;;) {
      const next = this.items.shift()
      if (next !== undefined) {
        yield next
      } else if (this.ended) {
        return
      } else {
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
      }
    }
  }

  private poke(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
  }
}

/** A scripted stand-in for Claude Code: it acts out tool calls and replies, and runs nothing. */
class DemoAgent {
  private readonly session: string
  private readonly outbox = new Outbox()
  private readonly options: Options
  private interrupted = false

  constructor(options: Options) {
    this.options = options
    this.session = options.resume ?? randomUUID()
  }

  private sdk(m: Message): void {
    this.outbox.push({ session_id: this.session, uuid: randomUUID(), ...m })
  }

  private assistant(content: unknown[]): void {
    const message = { id: randomUUID(), type: 'message', role: 'assistant', model: 'demo', content }
    this.sdk({ type: 'assistant', parent_tool_use_id: null, message })
  }

  private toolResult(id: string, content: string): void {
    const message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }
    this.sdk({ type: 'user', parent_tool_use_id: null, message })
  }

  private act(): Act {
    return {
      cwd: this.options.cwd ?? '',
      stopped: () => this.interrupted || this.outbox.ended,
      say: async (text) => {
        await sleep(STEP_MS)
        this.assistant([{ type: 'text', text }])
      },
      tool: async (name, input, output) => {
        await sleep(STEP_MS)
        const id = `toolu_demo_${randomUUID().slice(0, 12)}`
        this.assistant([{ type: 'tool_use', id, name, input }])
        await sleep(STEP_MS)
        this.toolResult(id, output)
      },
      ask: async (name, input, reason) => {
        await sleep(STEP_MS)
        const id = `toolu_demo_${randomUUID().slice(0, 12)}`
        this.assistant([{ type: 'tool_use', id, name, input }])
        const signal = new AbortController().signal
        const options = { signal, toolUseID: id, requestId: `req_${id}`, decisionReason: reason }
        const answer = await this.options.canUseTool?.(name, input, options)
        const allowed = answer?.behavior === 'allow'
        this.toolResult(id, allowed ? 'Done. (Simulated: the demo runs nothing.)' : (answer?.message ?? 'Denied'))
        return allowed
      },
    }
  }

  private result(turns: number): void {
    this.sdk({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      errors: [],
      total_cost_usd: 0.02 * turns,
      duration_ms: turns * STEP_MS,
      num_turns: turns,
    })
  }

  async run(input: AsyncIterable<UserMessage>): Promise<void> {
    for await (const m of input) {
      if (this.outbox.ended) {
        break
      }
      this.interrupted = false
      const steps = await playTurn(textOf(m), this.act())
      this.result(steps)
    }
    this.close()
  }

  interrupt(): void {
    this.interrupted = true
  }

  close(): void {
    this.interrupted = true
    this.outbox.end()
  }

  messages(): AsyncGenerator<Message> {
    return this.outbox.drain()
  }
}

/** The Agent SDK's streaming `query`, as far as Seti's runner uses it; the demo loads it by path. */
export function query({ prompt, options = {} }: { prompt: AsyncIterable<UserMessage>; options?: Options }) {
  const agent = new DemoAgent(options)
  void agent.run(prompt)
  return Object.assign(agent.messages(), {
    interrupt: async () => {
      agent.interrupt()
      return Promise.resolve()
    },
    stopTask: async () => Promise.resolve(),
    mcpServerStatus: async () => Promise.resolve([]),
    close: () => {
      agent.close()
    },
  })
}
