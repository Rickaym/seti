import { upgradeWebSocket } from '@hono/node-server'
import {
  terminalClientMessage,
  terminalParams,
  terminalQuery,
  type TerminalServerMessage,
  type TerminalSize,
} from '@seti/shared'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import type { WSContext, WSEvents } from 'hono/ws'
import { WebSocket } from 'ws'
import { isSameOrigin } from '../access.js'
import { forgetProcesses } from '../agent-processes.js'
import { notEa } from '../ea-guard.js'
import { fail, ok, valid } from '../http.js'
import { InputBudget } from '../terminal-io.js'
import {
  attachTerminal,
  closedMessage,
  detachTerminal,
  resizeTerminal,
  stopTerminal,
  terminalPlace,
  writeTerminal,
  type TerminalClient,
  type TerminalRequest,
} from '../terminal.js'

/** The largest frame a browser may send; an input message carries at most 8192 characters. */
export const TERMINAL_FRAME_MAX = 64 * 1024
const PING_MS = 25_000
/** Close codes: the terminal ended or moved, input broke the rules, or it could not start. */
const CLOSE_DONE = 4000
const CLOSE_POLICY = 1008
const CLOSE_FAILED = 4001

/** A browser's terminal socket needs Seti's own page: it carries the session cookie on its own. */
const sameOriginSocket: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header('origin')
  if (origin === undefined || !isSameOrigin(origin)) {
    return fail(c, 403, 'Forbidden', 'Terminals open only from Seti itself')
  }
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return fail(c, 426, 'Upgrade required', 'A terminal is a WebSocket')
  }
  await next()
  return undefined
}

interface Opening {
  request: TerminalRequest
  size: TerminalSize
}

function openingOf(c: Context): Opening {
  const { cols, rows, task, resume, shell, at } = terminalQuery.parse(c.req.query())
  const since = shell === undefined || at === undefined ? null : { shell, at }
  const request = { id: c.req.param('id') ?? '', taskId: task ?? null, resume: resume !== undefined, since }
  return { request, size: { cols, rows } }
}

/** Refuses before the upgrade a terminal for an agent that is gone, or one running for another. */
const openable: MiddlewareHandler = async (c, next) => {
  const { request } = openingOf(c)
  await terminalPlace(request.id, request.taskId)
  await next()
  return undefined
}

function parseMessage(data: unknown) {
  if (typeof data !== 'string') {
    return null
  }
  try {
    const parsed = terminalClientMessage.safeParse(JSON.parse(data))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** The terminal's view of one socket; `gone` once the browser closed it. */
class SocketClient implements TerminalClient {
  gone = false
  private readonly ws: WSContext
  private readonly raw: WebSocket | null
  private alive = true
  private readonly pinger: NodeJS.Timeout | null

  constructor(ws: WSContext) {
    this.ws = ws
    this.raw = ws.raw instanceof WebSocket ? ws.raw : null
    const raw = this.raw
    this.pinger =
      raw === null
        ? null
        : setInterval(() => {
            if (!this.alive) {
              raw.terminate()
              return
            }
            this.alive = false
            raw.ping()
          }, PING_MS)
    raw?.on('pong', () => {
      this.alive = true
    })
  }

  output(data: Buffer): void {
    if (this.raw !== null) {
      this.raw.send(data, { binary: true })
    } else {
      this.ws.send(new Uint8Array(data))
    }
  }

  message(message: TerminalServerMessage): void {
    this.ws.send(JSON.stringify(message))
  }

  close(code = CLOSE_DONE): void {
    this.ws.close(code)
  }

  backlog(): number {
    return this.raw?.bufferedAmount ?? 0
  }

  ended(): void {
    this.gone = true
    if (this.pinger !== null) {
      clearInterval(this.pinger)
    }
  }
}

function terminalEvents({ request, size }: Opening): WSEvents {
  const { id } = request
  let client: SocketClient | null = null
  const budget = new InputBudget()
  return {
    onOpen: (_event, ws) => {
      const opened = new SocketClient(ws)
      client = opened
      attachTerminal(request, opened, size)
        .then(() => {
          if (opened.gone) {
            detachTerminal(id, opened)
          }
        })
        .catch((e: unknown) => {
          opened.message(closedMessage('failed', null, e instanceof Error ? e.message : String(e)))
          opened.close(CLOSE_FAILED)
        })
    },
    onMessage: (event: { data: unknown }, ws) => {
      const message = parseMessage(event.data)
      if (client === null || message === null) {
        ws.close(CLOSE_POLICY, 'Send JSON terminal messages')
        return
      }
      if (message.type === 'resize') {
        resizeTerminal(id, client, message)
        return
      }
      if (!budget.take(Buffer.byteLength(message.data))) {
        client.message(closedMessage('flood'))
        detachTerminal(id, client)
        ws.close(CLOSE_POLICY, 'Input too fast')
        return
      }
      writeTerminal(id, client, message.data)
    },
    onClose: () => {
      if (client !== null) {
        client.ended()
        detachTerminal(id, client)
      }
    },
  }
}

/**
 * The user's interactive terminals, mounted under /api/terminals: each in an agent's directory as
 * its `!` commands run, or in the home folder. Interactive shells stay the user's: the EA never
 * opens, uses or stops one.
 */
export const terminalRoutes = new Hono()
  .use('/:id', notEa('open a terminal'))
  .use('/:id/*', notEa('use terminals'))
  .get(
    '/:id',
    sameOriginSocket,
    valid('param', terminalParams),
    valid('query', terminalQuery),
    openable,
    upgradeWebSocket((c) => terminalEvents(openingOf(c))),
  )
  .post('/:id/stop', valid('param', terminalParams), (c) => {
    const stopped = stopTerminal(c.req.valid('param').id)
    if (stopped.task_id !== null) {
      forgetProcesses(stopped.task_id)
    }
    return ok(c, stopped)
  })
