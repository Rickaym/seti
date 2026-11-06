import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'
import { eaChatInput, eaIcePatchInput, eaOfferInput, type EaNotRunning } from '@seti/shared'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { audit } from '../audit.js'
import { claimSend, releaseSend, sendKey } from '../client-sends.js'
import { credential } from '../credentials.js'
import { recordChatReply, repeatedChat } from '../ea-chat-sends.js'
import { fail, validJson } from '../http.js'

const CONNECT_TIMEOUT_MS = 2_000
const ANSWER_TIMEOUT_MS = 30_000
const BODY_MAX = 512 * 1024

/** The bot could not be reached at all, as opposed to answering slowly or with an error. */
class EaUnreachable extends Error {}

class EaTimeout extends Error {}

type Method = 'GET' | 'POST' | 'PATCH'

function errorCode(e: unknown): string {
  if (e instanceof Error && 'code' in e && typeof e.code === 'string') {
    return e.code
  }
  return e instanceof Error ? e.message : String(e)
}

/** Sends one request to the bot; connecting has its own short deadline, answering a longer one. */
async function request(target: string, token: string | null, { method, path, body }: Forward) {
  const url = new URL(path, target)
  const client = url.protocol === 'https:' ? https : http
  const headers: http.OutgoingHttpHeaders = { accept: 'application/json' }
  if (token !== null) {
    headers.authorization = `Bearer ${token}`
  }
  if (body !== null) {
    headers['content-type'] = 'application/json'
    headers['content-length'] = Buffer.byteLength(body)
  }
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    let connected = false
    const req = client.request(url, { method, headers }, (res) => {
      clearTimeout(connectTimer)
      resolve(res)
    })
    const connectTimer = setTimeout(() => {
      req.destroy(new EaUnreachable(`no connection within ${String(CONNECT_TIMEOUT_MS)} ms`))
    }, CONNECT_TIMEOUT_MS)
    req.on('socket', (socket) => {
      if (!socket.connecting) {
        connected = true
        clearTimeout(connectTimer)
        return
      }
      socket.once('connect', () => {
        connected = true
        clearTimeout(connectTimer)
      })
    })
    req.setTimeout(ANSWER_TIMEOUT_MS, () => {
      req.destroy(new EaTimeout(`no answer within ${String(ANSWER_TIMEOUT_MS / 1000)} s`))
    })
    req.on('error', (e) => {
      clearTimeout(connectTimer)
      reject(connected || e instanceof EaTimeout ? e : new EaUnreachable(errorCode(e)))
    })
    req.end(body ?? undefined)
  })
}

const NO_STORE = 'no-store'

interface Forward {
  method: Method
  path: string
  body: string | null
}

type Unreachable = (c: Context, reason: string) => Response

const notRunning: Unreachable = (c, reason) => fail(c, 503, 'EA is not running', reason)

interface EaTarget {
  url: string
  token: string | null
}

/** Streams the bot's answer back with its status; only the content type crosses over. */
async function relay(c: Context, target: EaTarget, forward: Forward, unreachable = notRunning) {
  c.header('cache-control', NO_STORE)
  let res: http.IncomingMessage
  try {
    res = await request(target.url, target.token, forward)
  } catch (e) {
    if (e instanceof EaUnreachable) {
      return unreachable(c, `Nothing answers at ${target.url} (${e.message})`)
    }
    const detail = e instanceof Error ? e.message : String(e)
    return fail(c, e instanceof EaTimeout ? 504 : 502, 'EA did not answer', detail)
  }
  const headers = new Headers({ 'cache-control': NO_STORE })
  const type = res.headers['content-type']
  if (type !== undefined) {
    headers.set('content-type', type)
  }
  const status = res.statusCode ?? 502
  const empty = status === 204 || status === 304
  if (empty) {
    res.resume()
  }
  return new Response(empty ? null : Readable.toWeb(res), { status, headers })
}

const CHAT_SUMMARY_CHARS = 80

const clip = (text: string) =>
  text.length > CHAT_SUMMARY_CHARS ? `${text.slice(0, CHAT_SUMMARY_CHARS - 3).trimEnd()}...` : text

const limit = bodyLimit({
  maxSize: BODY_MAX,
  onError: (c) => fail(c, 413, 'Request too large', 'The EA request body is too large'),
})

/** Health polls from every page, so a bot that is not running is an answer, not an error. */
const reportNotRunning: Unreachable = (c, reason) => c.json<EaNotRunning>({ running: false, reason })

/** Sends a typed message to the bot and audits it once the bot takes it. */
async function relayChat(c: Context, target: EaTarget, input: { text: string }) {
  const res = await relay(c, target, { method: 'POST', path: '/chat', body: JSON.stringify(input) })
  if (res.ok) {
    await audit.record({
      actor: 'user',
      kind: 'ea.chat_message',
      subject_type: 'ea',
      summary: `Sent the EA "${clip(input.text)}"`,
      detail: { text: input.text },
    })
  }
  return res
}

/** Forwards the EA endpoints to the voice bot at `target`; bodies are validated, then sent as is. */
export function eaRoutes(url: string, token: string | null = credential('local-token-ea')): Hono {
  const target: EaTarget = { url, token }
  return new Hono()
    .get('/health', async (c) => relay(c, target, { method: 'GET', path: '/health', body: null }, reportNotRunning))
    .get('/ice', async (c) => relay(c, target, { method: 'GET', path: '/ice', body: null }))
    .post('/offer', limit, validJson(eaOfferInput), async (c) =>
      relay(c, target, { method: 'POST', path: '/offer', body: await c.req.text() }),
    )
    .patch('/offer', limit, validJson(eaIcePatchInput), async (c) =>
      relay(c, target, { method: 'PATCH', path: '/offer', body: await c.req.text() }),
    )
    .post('/chat', limit, validJson(eaChatInput), async (c) => {
      const { client_id: clientId, ...input } = c.req.valid('json')
      const key = sendKey('ea_chat', 'ea', clientId)
      if (key !== null && (await claimSend(key)).state !== 'run') {
        return repeatedChat(key)
      }
      const release = async () => (key === null ? undefined : releaseSend(key))
      const res = await relayChat(c, target, input).catch(async (e: unknown) => {
        await release()
        throw e
      })
      if (!res.ok) {
        await release()
        return res
      }
      return key === null ? res : recordChatReply(res, key)
    })
}
