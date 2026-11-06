import {
  terminalServerMessage,
  TERMINAL_INPUT_CHARS,
  type TerminalClientMessage,
  type TerminalServerMessage,
  type TerminalSize,
} from '@seti/shared'

/** A shell a view shows, and how many bytes of its output the view drew. */
export interface ShellPosition {
  shell: string
  at: number
}

/** Which terminal a view connects to, for which agent, and whether it may start a new shell. */
interface TerminalTarget {
  id: string
  taskId: string | null
  resume: boolean
  /** Where the view got to before it lost its socket, so the server sends only the rest. */
  since: ShellPosition | null
}

/** True when `ready` picks up right where the view left off, so its screen stays as it is. */
export function resumes(shown: ShellPosition | null, ready: { shell: string; from: number }): boolean {
  return shown !== null && shown.shell === ready.shell && shown.at === ready.from
}

/** The socket of terminal `id` on the page's own host. */
export function terminalUrl(location: Pick<Location, 'protocol' | 'host'>, target: TerminalTarget, size: TerminalSize) {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const query = new URLSearchParams({ cols: String(size.cols), rows: String(size.rows) })
  if (target.taskId !== null) {
    query.set('task', target.taskId)
  }
  if (target.resume) {
    query.set('resume', '1')
  }
  if (target.since !== null) {
    query.set('shell', target.since.shell)
    query.set('at', String(target.since.at))
  }
  return `${scheme}//${location.host}/api/terminals/${encodeURIComponent(target.id)}?${query.toString()}`
}

/** Input as messages the server accepts, never splitting a character made of two code units. */
export function inputChunks(data: string, max = TERMINAL_INPUT_CHARS): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < data.length) {
    let end = Math.min(start + max, data.length)
    const last = data.charCodeAt(end - 1)
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) {
      end -= 1
    }
    chunks.push(data.slice(start, end))
    start = end
  }
  return chunks
}

/** Waits before each try to reach a terminal again, about 45 seconds in all; then null. */
const RETRY_MS = [250, 1000, 2000, 4000, 8000, 15_000, 15_000] as const

export const retryDelay = (attempt: number): number | null => RETRY_MS[attempt] ?? null

/** A text frame from the server, or null when it is not one Seti sends. */
export function parseServerMessage(text: string): TerminalServerMessage | null {
  try {
    const parsed = terminalServerMessage.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * The resize a terminal owes the server once its socket is ready: a fit while the socket was
 * still connecting had nowhere to go, so the shell would keep the size the address carried.
 */
export function resizeSince(sent: TerminalSize, now: TerminalSize): TerminalClientMessage | null {
  return sent.cols === now.cols && sent.rows === now.rows ? null : { type: 'resize', ...now }
}
