import type { TerminalClientMessage, TerminalClose } from '@seti/shared'
import type { Terminal } from '@xterm/xterm'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { shellStarts } from './shells'
import {
  inputChunks,
  parseServerMessage,
  resizeSince,
  resumes,
  retryDelay,
  terminalUrl,
  type ShellPosition,
} from './terminal-protocol'

/** The terminal a view connects to, and the agent whose folder its shell runs in. */
export interface ShellTarget {
  id: string
  taskId: string | null
}

export type Connection =
  | { state: 'connecting' }
  | { state: 'open' }
  /** The server ended or handed off the terminal, or Seti stayed out of reach. */
  | { state: 'closed'; reason: TerminalClose | 'lost'; detail: string }

/** Where a shell runs, as the server says once it is ready. */
export interface ShellWhere {
  cwd: string
  sandboxed: boolean
}

/** Terminals whose view is gone; output still on its way must not reach them. */
const retired = new WeakSet<Terminal>()

/**
 * Disposes `term` once the output it already took is drawn: xterm parses writes later, and one
 * parsed after dispose redraws a renderer that is gone.
 */
export function retire(term: Terminal): void {
  retired.add(term)
  term.write('', () => {
    term.dispose()
  })
}

/** Refusals of a reattach that mean the shell ended while no window showed it. */
const ENDED_UNSEEN: ReadonlySet<TerminalClose> = new Set(['gone', 'settings'])

/** Refs the socket reads as it goes, so a change to them needs no reconnect. */
interface SocketHooks {
  /** Changes typed input first, as a held soft Ctrl does. */
  transform: RefObject<(data: string) => string>
  /** Hears where the shell runs once the server started or reattached it. */
  ready: RefObject<((where: ShellWhere) => void) | undefined>
}

export interface TerminalSocket {
  connection: Connection
  /** Sends keystrokes or a soft key to the shell. */
  send: (data: string) => void
  /** Connects again: to the same shell, or to a new one when `fresh`. */
  restart: (fresh: boolean) => void
}

/**
 * Connects `term` to the terminal and reconnects while the server may still hold it. Only a
 * terminal the user just opened, or asked a new shell for, may start one; the rest only reattach.
 * A restored terminal whose shell ended while no window showed it starts a new one once `active`.
 */
export function useTerminalSocket(
  { id, taskId }: ShellTarget,
  term: Terminal | null,
  active: boolean,
  { transform, ready }: SocketHooks,
): TerminalSocket {
  const [connection, setConnection] = useState<Connection>({ state: 'connecting' })
  const [generation, setGeneration] = useState(0)
  const [ended, setEnded] = useState(false)
  const parked = ended && !active
  const socket = useRef<WebSocket | null>(null)
  /** The shell this view shows and how many bytes of its output it drew, to resume from. */
  const shown = useRef<ShellPosition | null>(null)

  const sendMessage = useCallback((message: TerminalClientMessage) => {
    const ws = socket.current
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message))
    }
  }, [])

  const send = useCallback(
    (data: string) => {
      for (const chunk of inputChunks(data)) {
        sendMessage({ type: 'input', data: chunk })
      }
    },
    [sendMessage],
  )

  useEffect(() => {
    if (term === null || parked) {
      return undefined
    }
    let attempt = 0
    let timer: number | undefined
    let disposed = false
    let closed = false
    const connect = () => {
      const target = { id, taskId, resume: !shellStarts.mayStart(id), since: shown.current }
      const sent = { cols: term.cols, rows: term.rows }
      const ws = new WebSocket(terminalUrl(window.location, target, sent))
      ws.binaryType = 'arraybuffer'
      socket.current = ws
      ws.onmessage = (event: MessageEvent<unknown>) => {
        if (retired.has(term)) {
          return
        }
        if (event.data instanceof ArrayBuffer) {
          if (shown.current !== null) {
            shown.current.at += event.data.byteLength
          }
          term.write(new Uint8Array(event.data))
          return
        }
        const message = typeof event.data === 'string' ? parseServerMessage(event.data) : null
        if (message?.type === 'ready') {
          attempt = 0
          if (!resumes(shown.current, message)) {
            term.reset()
          }
          shown.current = { shell: message.shell, at: message.from }
          shellStarts.done(id)
          ready.current?.({ cwd: message.cwd, sandboxed: message.sandboxed })
          setEnded(false)
          setConnection({ state: 'open' })
          const resize = resizeSince(sent, { cols: term.cols, rows: term.rows })
          if (resize !== null) {
            sendMessage(resize)
          }
        } else if (message?.type === 'closed') {
          closed = true
          if (target.resume && ENDED_UNSEEN.has(message.reason)) {
            shellStarts.allow(id)
            setEnded(true)
            setGeneration((value) => value + 1)
            return
          }
          setConnection({ state: 'closed', reason: message.reason, detail: message.detail })
        }
      }
      ws.onclose = () => {
        if (socket.current === ws) {
          socket.current = null
        }
        if (disposed || closed) {
          return
        }
        const delay = retryDelay(attempt)
        attempt += 1
        if (delay === null) {
          setConnection({ state: 'closed', reason: 'lost', detail: 'Seti cannot be reached' })
          return
        }
        setConnection({ state: 'connecting' })
        timer = window.setTimeout(connect, delay)
      }
    }
    connect()
    const typed = term.onData((data) => {
      send(transform.current(data))
    })
    const resized = term.onResize(({ cols, rows }) => {
      sendMessage({ type: 'resize', cols, rows })
    })
    return () => {
      disposed = true
      window.clearTimeout(timer)
      typed.dispose()
      resized.dispose()
      socket.current?.close()
      socket.current = null
    }
  }, [id, taskId, term, parked, generation, send, sendMessage, transform, ready])

  const restart = useCallback(
    (fresh: boolean) => {
      if (fresh) {
        shellStarts.allow(id)
      }
      setConnection({ state: 'connecting' })
      setGeneration((value) => value + 1)
    },
    [id],
  )

  return { connection, send, restart }
}
