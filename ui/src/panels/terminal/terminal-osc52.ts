import type { Terminal } from '@xterm/xterm'
import { toast } from 'sonner'

/** The most a program may copy at once, in bytes. */
const MAX_BYTES = 1024 * 1024

const MAX_BASE64 = Math.ceil(MAX_BYTES / 3) * 4

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u

/** The selections OSC 52 names: clipboard, primary, secondary, select and cut buffers 0 to 7. */
const TARGETS = /^[cpqs0-7]*$/u

/**
 * The text an OSC 52 payload (`targets;base64`) copies. Null for a read request (`?`), which
 * never gets an answer, and for a payload that is empty, malformed, not UTF-8 or over 1 MiB.
 */
export function osc52Text(payload: string): string | null {
  const split = payload.indexOf(';')
  const data = payload.slice(split + 1)
  if (split < 0 || !TARGETS.test(payload.slice(0, split)) || data.length > MAX_BASE64 || !BASE64.test(data)) {
    return null
  }
  try {
    const binary = atob(data)
    if (binary.length > MAX_BYTES) {
      return null
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
  } catch {
    return null
  }
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    toast.error('The browser did not let a program in the terminal copy to the clipboard', {
      id: 'terminal-osc52',
      duration: Infinity,
    })
  }
}

/** Lets programs in the terminal, such as tmux, copy to the clipboard but never read it. */
export function copyFromPrograms(term: Terminal): void {
  term.parser.registerOscHandler(52, (payload) => {
    const text = osc52Text(payload)
    if (text !== null) {
      void writeClipboard(text)
    }
    return true
  })
}
