import type { IncomingHttpHeaders } from 'node:http'
import { hostMatches } from '@seti/shared'

/** A connection the agent holds as a placeholder; the proxy swaps the value in on its hosts only. */
export interface EgressPlaceholder {
  name: string
  placeholder: string
  /** Exact host names or *.suffix patterns, over HTTPS on port 443. */
  hosts: readonly string[]
  /** The key, read for every request so a replaced value applies at once; null when unreadable. */
  value: () => Promise<string | null>
}

export type Swapped =
  | { kind: 'ok'; path: string; headers: IncomingHttpHeaders }
  | { kind: 'blocked'; names: string[] }
  | { kind: 'unreadable'; name: string }

const HEADER_UNSAFE = /[\r\n\0]/
const BASIC = /^basic\s+/i

const carries = (text: string, placeholder: string) => text.includes(placeholder)

/** Basic credentials hide a placeholder in base64, as SDKs that send the key as a password do. */
function basicText(value: string): string | null {
  if (!BASIC.test(value)) {
    return null
  }
  return Buffer.from(value.replace(BASIC, ''), 'base64').toString('utf8')
}

function headerTexts(headers: IncomingHttpHeaders): string[] {
  return Object.values(headers).flatMap((value) => {
    if (value === undefined) {
      return []
    }
    const values = Array.isArray(value) ? value : [value]
    return values.flatMap((text) => [text, basicText(text) ?? ''])
  })
}

function swapHeader(text: string, placeholder: string, value: string): string {
  const basic = basicText(text)
  if (basic !== null && carries(basic, placeholder)) {
    const scheme = BASIC.exec(text)?.[0] ?? 'Basic '
    return `${scheme}${Buffer.from(basic.replaceAll(placeholder, value)).toString('base64')}`
  }
  return text.replaceAll(placeholder, value)
}

function swapHeaders(headers: IncomingHttpHeaders, placeholder: string, value: string): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {}
  for (const [name, text] of Object.entries(headers)) {
    if (Array.isArray(text)) {
      out[name] = text.map((item) => swapHeader(item, placeholder, value))
    } else if (text !== undefined) {
      out[name] = swapHeader(text, placeholder, value)
    }
  }
  return out
}

/** Whether a placeholder's key may go to host:port: HTTPS to one of its hosts, nothing else. */
export const placeholderAllowed = (entry: EgressPlaceholder, host: string, port: number) =>
  port === 443 && entry.hosts.some((pattern) => hostMatches(pattern, host))

/**
 * The request path and headers with every placeholder they carry swapped for its key, or the
 * keys whose placeholders head somewhere their hosts do not cover. Bodies pass unread.
 */
export async function swapPlaceholders(
  target: { host: string; port: number },
  path: string,
  headers: IncomingHttpHeaders,
  entries: readonly EgressPlaceholder[],
): Promise<Swapped> {
  const texts = [path, ...headerTexts(headers)]
  const found = entries.filter((entry) => texts.some((text) => carries(text, entry.placeholder)))
  const blocked = found.filter((entry) => !placeholderAllowed(entry, target.host, target.port))
  if (blocked.length > 0) {
    return { kind: 'blocked', names: blocked.map((entry) => entry.name) }
  }
  let swapped = { path, headers }
  for (const entry of found) {
    const value = await entry.value().catch(() => null)
    if (value === null || value === '' || HEADER_UNSAFE.test(value)) {
      return { kind: 'unreadable', name: entry.name }
    }
    swapped = {
      path: swapped.path.replaceAll(entry.placeholder, encodeURIComponent(value)),
      headers: swapHeaders(swapped.headers, entry.placeholder, value),
    }
  }
  return { kind: 'ok', ...swapped }
}

/** Why a request carrying connection placeholders was refused, naming them but no value. */
const blockedText = (host: string, names: readonly string[]) =>
  `Seti sandbox proxy: refused a request to ${host} carrying the placeholder of ${names.join(', ')}. ` +
  'Seti sends a connection only to the hosts the user allowed for it.'

/** A request's path and headers once the task's connections are in place. */
export interface Keyed {
  path: string
  headers: IncomingHttpHeaders
}

export interface Refusal {
  status: number
  reason: string
  body: string
}

/** The request with the task's connections swapped in, or the answer that refuses it. */
export async function keyRequest(
  request: { target: { host: string; port: number }; path: string; headers: IncomingHttpHeaders },
  entries: readonly EgressPlaceholder[],
  onBlocked?: (host: string, names: readonly string[]) => void,
): Promise<Keyed | Refusal> {
  const { target, path, headers } = request
  if (entries.length === 0) {
    return { path, headers }
  }
  const swapped = await swapPlaceholders(target, path, headers, entries)
  if (swapped.kind === 'blocked') {
    onBlocked?.(target.host, swapped.names)
    return { status: 403, reason: 'Forbidden', body: blockedText(target.host, swapped.names) }
  }
  if (swapped.kind === 'unreadable') {
    const body = `Seti sandbox proxy has no value for the connection ${swapped.name}. Ask the user to set it.`
    return { status: 502, reason: 'Bad Gateway', body }
  }
  return { path: swapped.path, headers: swapped.headers }
}
