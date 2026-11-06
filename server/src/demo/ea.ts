import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { eaChatInput, type EaChatEvent, type EaHealth } from '@seti/shared'
import { eaHistory } from '../store/ea.js'

const HEALTH: EaHealth = {
  ok: true,
  configured: false,
  missing: [],
  model: null,
  text_model: 'demo',
  chat_missing: [],
  turn: false,
}

const REPLY = [
  'In the demo I answer every message with this note. ',
  'In your own Seti I read your agents, start and steer them, follow your channels, ',
  'and talk it through by voice or text, through the same API the UI uses.',
]

const BODY_MAX = 64 * 1024

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > BODY_MAX) {
      return null
    }
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/** Streams the scripted reply and stores the exchange in the EA's history, as the real EA does. */
async function chat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const input = eaChatInput.safeParse(await readBody(req).catch(() => null))
  if (!input.success) {
    res.writeHead(400).end()
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
  const send = ({ type, ...data }: EaChatEvent) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
  for (const delta of REPLY) {
    await sleep(250)
    send({ type: 'text', delta })
  }
  const ids = await eaHistory.append({
    entries: [
      { kind: 'chat', message: { role: 'user', content: input.data.text } },
      { kind: 'chat', message: { role: 'assistant', content: REPLY.join('') } },
    ],
  })
  send({ type: 'done', ids })
  res.end()
}

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(HEALTH))
  } else if (req.method === 'POST' && req.url === '/chat') {
    chat(req, res).catch(() => res.destroy())
  } else {
    res
      .writeHead(503, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: 'Voice is off in the demo' }))
  }
}

/** A stand-in for the EA voice bot on a loopback port; it answers health and typed chat only. */
export async function startDemoEa(): Promise<string> {
  const server = http.createServer(handle)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}
