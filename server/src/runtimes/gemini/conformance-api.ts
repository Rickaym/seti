import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { echoOf, type ScriptCall, type Step } from '../conformance/script.js'

/** A part of a Gemini API message: text, a thought, or a function call or its response. */
type Part = Record<string, unknown>

interface Content {
  role?: string
  parts?: Part[]
}

/** The function call Gemini CLI gets for a neutral script call. */
export interface ModelCall {
  name: string
  args: Record<string, unknown>
}

/** How a neutral script call reaches Gemini CLI. */
type CallMapper = (call: ScriptCall) => ModelCall

/** What Gemini CLI's own routing and checks ask for, answered so the main model is used. */
const ROUTED = {
  reasoning: 'scripted',
  next_speaker: 'user',
  model_choice: 'flash',
  complexity_reasoning: 'scripted',
  complexity_score: 1,
}

/** The step ends a model response: Gemini CLI answers a call, and a held response never ends. */
const endsRound = (step: Step): boolean => 'call' in step || 'hold' in step

function round(steps: readonly Step[]): Step[] {
  const at = steps.findIndex(endsRound)
  return at === -1 ? [...steps] : steps.slice(0, at + 1)
}

/** Context Gemini CLI adds as user text: its session context and environment notes. */
const CONTEXT = /^\s*(?:<[a-z_]+>|This is the Gemini CLI)/

/** The user texts of a request in order, and how many came before the model last spoke. */
function conversation(contents: readonly Content[]): { texts: string[]; spoken: number } {
  const texts: string[] = []
  let spoken = 0
  for (const content of contents) {
    if (content.role === 'model') {
      spoken = texts.length
      continue
    }
    for (const part of content.parts ?? []) {
      if (typeof part.text === 'string' && !CONTEXT.test(part.text)) {
        texts.push(part.text)
      }
    }
  }
  return { texts, spoken }
}

/** The request continues a turn: its last message answers the model's function call. */
const answersCall = (contents: readonly Content[]): boolean =>
  (contents.at(-1)?.parts ?? []).some((part) => 'functionResponse' in part)

/** What the scripted model knows of the turn it plays: its steps and how many it answered. */
interface TurnState {
  steps: Step[] | null
  done: number
  base: number
}

/**
 * A local Gemini API that answers Gemini CLI's model calls from a neutral script. A request whose
 * last message is the user's starts the next turn; one that answers a call continues it.
 */
export class ScriptedGemini {
  /** Every main model call's request body, in order. */
  readonly bodies: string[] = []
  /** The function responses Gemini CLI sent back, as `<function> <response as JSON>`. */
  readonly responses: string[] = []
  private turns: Step[][] = []
  private next = 0
  private state: TurnState | null = null
  private readonly server: Server
  private readonly mapCall: CallMapper

  constructor(mapCall: CallMapper) {
    this.mapCall = mapCall
    this.server = createServer((req, res) => {
      this.handle(req, res)
    })
  }

  /** Starts listening on a free loopback port; resolves with the base URL Gemini CLI is given. */
  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`
  }

  /** Plays this script from its first turn; earlier state is forgotten. */
  play(turns: Step[][]): void {
    this.turns = turns
    this.next = 0
    this.state = null
    this.responses.length = 0
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
      const url = req.url ?? ''
      if (req.method !== 'POST' || !url.startsWith('/v1beta/models/')) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"not scripted"}}')
        return
      }
      if (url.includes(':countTokens')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"totalTokens":10}')
        return
      }
      const body = JSON.parse(raw) as { contents?: Content[]; tools?: Record<string, unknown>[] }
      const streamed = url.includes(':streamGenerateContent')
      const tools = body.tools ?? []
      if (!tools.some((tool) => 'functionDeclarations' in tool)) {
        // Routing and checks name no tools; a web fetch asks the model to read its URLs itself.
        const text = tools.length === 0 ? JSON.stringify(ROUTED) : 'Fetched.'
        reply(res, [{ text }], streamed, true)
        return
      }
      this.bodies.push(raw)
      const contents = body.contents ?? []
      this.noteResponses(contents)
      const steps = this.answer(contents)
      const parts = steps.filter((step) => !('hold' in step)).map((step) => this.part(step, contents))
      reply(res, parts, streamed, !steps.some((step) => 'hold' in step))
    })
  }

  private noteResponses(contents: readonly Content[]): void {
    for (const part of contents.at(-1)?.parts ?? []) {
      const answered = part.functionResponse as { name?: unknown; response?: unknown } | undefined
      if (answered !== undefined) {
        this.responses.push(`${String(answered.name)} ${JSON.stringify(answered.response)}`)
      }
    }
  }

  private answer(contents: readonly Content[]): Step[] {
    const said = conversation(contents)
    if (this.state === null || !answersCall(contents)) {
      this.state = { steps: this.turns[this.next] ?? null, done: 0, base: said.spoken }
      this.next += 1
    }
    const { state } = this
    if (state.steps === null) {
      return state.done++ === 0 ? [{ say: echoOf(said.texts.slice(state.base)) }] : [{ say: '' }]
    }
    const steps = round(state.steps.slice(state.done))
    state.done += steps.length
    return steps
  }

  private part(step: Step, contents: readonly Content[]): Part {
    if ('say' in step) {
      return { text: step.say }
    }
    if ('think' in step) {
      return { text: step.think, thought: true }
    }
    if ('recall' in step) {
      return { text: conversation(contents).texts.join('|') }
    }
    if ('call' in step) {
      const call = this.mapCall(step.call)
      return { functionCall: { name: call.name, args: call.args } }
    }
    return { text: `The scripted model cannot play ${Object.keys(step).join(', ')}` }
  }
}

const USAGE = { promptTokenCount: 1200, candidatesTokenCount: 40, totalTokenCount: 1240, cachedContentTokenCount: 1000 }

/** Answers one model call, one part per streamed chunk; a held stream never ends. */
function reply(res: ServerResponse, parts: Part[], streamed: boolean, ends: boolean): void {
  const chunk = (some: Part[], last: boolean) => ({
    candidates: [{ content: { role: 'model', parts: some }, ...(last ? { finishReason: 'STOP' } : {}), index: 0 }],
    ...(last ? { usageMetadata: USAGE } : {}),
    modelVersion: 'scripted',
  })
  if (!streamed) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(chunk(parts, true)))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  parts.forEach((part, index) => {
    res.write(`data: ${JSON.stringify(chunk([part], ends && index === parts.length - 1))}\r\n\r\n`)
  })
  if (ends) {
    if (parts.length === 0) {
      res.write(`data: ${JSON.stringify(chunk([], true))}\r\n\r\n`)
    }
    res.end()
  }
}
