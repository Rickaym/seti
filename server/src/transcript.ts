import {
  asEventsRow,
  type MessagePage,
  type MessageRow,
  type ShellResult,
  type WirePage,
  type WireRow,
} from '@seti/shared'
import { fromDelegate } from './ea-guard.js'
import { wireClaude } from './runtimes/claude/wire.js'
import { wireCodex } from './runtimes/codex/wire.js'
import { scrubValue } from './scrub.js'
import { trimText, WIRE_TEXT_LIMIT, type Wire } from './wire-text.js'

const SHELL_STREAMS = ['stdout', 'stderr'] as const

/** Shell output cut like tool text; `trimmed` names the streams that lost their tail. */
function wireShell(payload: ShellResult): Wire<ShellResult> {
  const cut = SHELL_STREAMS.filter((stream) => payload[stream].length > WIRE_TEXT_LIMIT)
  if (cut.length === 0) {
    return { value: payload, cut: [] }
  }
  return { value: { ...payload, stdout: trimText(payload.stdout), stderr: trimText(payload.stderr) }, cut }
}

function trimRow(row: MessageRow): MessageRow {
  if (row.kind === 'shell') {
    const { value, cut } = wireShell(row.payload)
    return cut.length === 0 ? row : { ...row, payload: value, trimmed: cut }
  }
  if (row.kind !== 'sdk') {
    return row
  }
  if (row.runtime === 'gemini') {
    return row
  }
  if (row.runtime === 'codex') {
    const { value, cut } = wireCodex(row.payload)
    return cut.length === 0 ? { ...row, payload: value } : { ...row, payload: value, trimmed: cut }
  }
  const { value, cut } = wireClaude(row.payload)
  return cut.length === 0 ? { ...row, payload: value } : { ...row, payload: value, trimmed: cut }
}

/** How a client takes runtime rows: as neutral events, or as the runtime stored them. */
export type WireForm = 'events' | 'stored'

/** The form a request asked for; the EA, agents and mods get events only (RT-7). */
export const wireFormOf = (query: { wire?: 'events' | undefined }): WireForm =>
  query.wire === 'events' || fromDelegate() ? 'events' : 'stored'

/** A redacted row in the form the client asked for. */
const inForm = (row: MessageRow, form: WireForm): WireRow => (form === 'events' ? asEventsRow(row) : row)

/** The browser copy of a stored message: text cut with a marker, credentials redacted. */
export const wireRow = (row: MessageRow): MessageRow => scrubValue(trimRow(row))

const wirePage = (page: MessagePage): MessagePage => ({ ...page, messages: page.messages.map(wireRow) })

/** The browser copy of a stored message in the form the client asked for. */
export const clientRow = (row: MessageRow, form: WireForm): WireRow => inForm(wireRow(row), form)

export function clientPage(page: MessagePage, form: WireForm): WirePage {
  const shown = wirePage(page)
  return { ...shown, messages: shown.messages.map((row) => inForm(row, form)) }
}

/** A stored message whole, as "show full output" fetches it, with credentials redacted. */
export const fullRow = (row: MessageRow, form: WireForm): WireRow => inForm(scrubValue(row), form)
