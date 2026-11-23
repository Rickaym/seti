import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { echoOf, type ScriptCall, type Step } from '../conformance/script.js'

/** One output item of the OpenAI Responses API, as the scripted model sends it. */
type OutputItem = Record<string, unknown> & { type: string; id: string }

/** The model's call for a neutral script call: a function with arguments, or a free-form tool. */
export type ModelCall =
  { name: string; args: Record<string, unknown>; namespace?: string } | { name: string; input: string }

/** How a neutral script call reaches Codex. */
export type CallMapper = (call: ScriptCall) => ModelCall

let seq = 0
const nextId = (prefix: string) => {
  seq += 1
  return `${prefix}_${String(seq).padStart(5, '0')}`
}

const say = (text: string): OutputItem => ({
  type: 'message',
  id: nextId('msg'),
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
})

const think = (text: string): OutputItem => ({
  type: 'reasoning',
  id: nextId('rs'),
  summary: [{ type: 'summary_text', text }],
  content: [],
  encrypted_content: null,
})

/** The step ends a model response: Codex answers a call, and a held response never ends. */
const endsRound = (step: Step): boolean => 'call' in step || 'hold' in step || 'awaitInput' in step

/** Steps that hold the response open rather than add an item to it. */
const waits = (step: Step): boolean => 'hold' in step || 'awaitInput' in step

/** The steps of one model response: up to and including the first that ends it, or all left. */
function round(steps: readonly Step[]): Step[] {
  const at = steps.findIndex(endsRound)
  return at === -1 ? [...steps] : steps.slice(0, at + 1)
}

/** What the scripted model knows of one turn: its steps, how many it answered, its first input. */
interface TurnState {
  /** Null for a turn past the script's end, which says its inputs back. */
  steps: Step[] | null
  done: number
  /** How many of the conversation's user texts came before this turn. */
  base: number
}

const META = 'x-codex-turn-metadata'

/** The thread and turn a request belongs to, from the metadata header Codex sends on each call. */
function turnOf(req: IncomingMessage): { thread: string; turn: string } {
  const header = req.headers[META]
  const meta = JSON.parse(typeof header === 'string' ? header : '{}') as { thread_id?: string; turn_id?: string }
  return { thread: meta.thread_id ?? '', turn: meta.turn_id ?? '' }
}

/** Context Codex adds as user messages, such as the environment or a note that a turn was cut. */
const CONTEXT = /(?:^\s*<[a-z_]+>)|AGENTS\.md/

/** The user texts of one input item, Codex's own context left out. */
const textsOf = (item: Record<string, unknown>): string[] => {
  const parts = Array.isArray(item.content) ? (item.content as { text?: unknown }[]) : []
  const texts = parts.flatMap((part) => (typeof part.text === 'string' ? [part.text] : []))
  return texts.some((text) => CONTEXT.test(text)) ? [] : texts
}

/** The user texts of a request in order, and how many came before the model last spoke. */
function conversation(body: unknown): { texts: string[]; spoken: number } {
  const input = (body as { input?: unknown }).input
  const items = Array.isArray(input) ? (input as Record<string, unknown>[]) : []
  const texts: string[] = []
  let spoken = 0
  for (const item of items) {
    if (item.type === 'message' && item.role === 'user') {
      texts.push(...textsOf(item))
    } else if (item.role === 'assistant' || item.type !== 'message') {
      spoken = texts.length
    }
  }
  return { texts, spoken }
}

/** A local Responses API that answers Codex's model calls from a neutral script. */
export class ScriptedResponses {
  private turns: Step[][] = []
  private readonly states = new Map<string, TurnState>()
  private readonly order = new Map<string, number>()
  private readonly server: Server
  private readonly mapCall: CallMapper
  private wake: (() => void) | null = null
  private early = false

  constructor(mapCall: CallMapper) {
    this.mapCall = mapCall
    this.server = createServer((req, res) => {
      this.handle(req, res)
    })
  }

  /** Starts listening on a free loopback port; resolves with the base URL Codex is given. */
  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}/v1`
  }

  /** Plays this script from its first turn; earlier state is forgotten. */
  play(turns: Step[][]): void {
    this.turns = turns
    this.wake = null
    this.early = false
    this.states.clear()
    this.order.clear()
  }

  close(): void {
    this.server.closeAllConnections()
    this.server.close()
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
    })
    req.on('end', () => {
      if (req.method !== 'POST' || !(req.url ?? '').endsWith('/responses')) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"not scripted"}}')
        return
      }
      const said = conversation(JSON.parse(raw) as unknown)
      const steps = this.answer(turnOf(req), said)
      const items = steps.filter((step) => !waits(step)).map((step) => this.item(step, said.texts))
      stream(res, items, this.endOf(steps))
    })
  }

  /** Lets a response that waits for steered input end; an input that came first counts. */
  steered(): void {
    const wake = this.wake
    this.wake = null
    this.early = wake === null
    wake?.()
  }

  /** When a response ends: never while it holds, after the next input while it waits for one. */
  private endOf(steps: readonly Step[]): Promise<void> | null {
    if (steps.some((step) => 'hold' in step)) {
      return null
    }
    return steps.some((step) => 'awaitInput' in step) ? this.nextInput() : Promise.resolve()
  }

  private async nextInput(): Promise<void> {
    if (this.early) {
      this.early = false
      return
    }
    await new Promise<void>((resolve) => {
      this.wake = resolve
    })
  }

  /** The steps of the next response in this turn; a turn past the script says its inputs back. */
  private answer(at: { thread: string; turn: string }, said: { texts: string[]; spoken: number }): Step[] {
    const key = `${at.thread}:${at.turn}`
    let state = this.states.get(key)
    if (state === undefined) {
      const index = this.order.get(at.thread) ?? 0
      this.order.set(at.thread, index + 1)
      state = { steps: this.turns[index] ?? null, done: 0, base: said.spoken }
      this.states.set(key, state)
    }
    if (state.steps === null) {
      return [{ say: echoOf(said.texts.slice(state.base)) }]
    }
    const steps = round(state.steps.slice(state.done))
    state.done += steps.length
    return steps
  }

  private item(step: Step, texts: readonly string[]): OutputItem {
    if ('say' in step) {
      return say(step.say)
    }
    if ('think' in step) {
      return think(step.think)
    }
    if ('recall' in step) {
      return say(texts.join('|'))
    }
    if ('call' in step) {
      return modelCall(this.mapCall(step.call))
    }
    return say(`The scripted model cannot play ${Object.keys(step).join(', ')}`)
  }
}

function modelCall(call: ModelCall): OutputItem {
  const ids = { call_id: nextId('call'), name: call.name, status: 'completed' }
  if ('input' in call) {
    return { type: 'custom_tool_call', id: nextId('ctc'), ...ids, input: call.input }
  }
  const namespace = call.namespace === undefined ? {} : { namespace: call.namespace }
  return { type: 'function_call', id: nextId('fc'), ...ids, arguments: JSON.stringify(call.args), ...namespace }
}

function sse(res: ServerResponse, event: Record<string, unknown>): void {
  res.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
}

/** Streams one response the way the Responses API does; it ends with usage once `ended` settles. */
function stream(res: ServerResponse, items: readonly OutputItem[], ended: Promise<void> | null): void {
  const id = nextId('resp')
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  sse(res, { type: 'response.created', response: { id, status: 'in_progress' } })
  items.forEach((item, index) => {
    sse(res, { type: 'response.output_item.added', output_index: index, item: { ...item, status: 'in_progress' } })
    sse(res, { type: 'response.output_item.done', output_index: index, item })
  })
  void ended?.then(() => {
    complete(res, id)
  })
}

function complete(res: ServerResponse, id: string): void {
  const usage = {
    input_tokens: 1200,
    input_tokens_details: { cached_tokens: 1000 },
    output_tokens: 40,
    output_tokens_details: { reasoning_tokens: 12 },
    total_tokens: 1240,
  }
  sse(res, { type: 'response.completed', response: { id, status: 'completed', usage } })
  res.end()
}
