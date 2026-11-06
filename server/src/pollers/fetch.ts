import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { urlAllowed } from '@seti/shared'
import { z } from 'zod'

/** What a poll script's fetch gets back, with every secret value replaced. */
export interface PollResponse {
  status: number
  url: string
  headers: [string, string][]
  body: string
}

export interface PollFetchConfig {
  /** The sandbox allowlist plus the poller's extra hosts. */
  allowed: readonly string[]
  /** Secrets this poller may use, by the name its templates give. */
  secrets: ReadonlyMap<string, string>
  responseMaxBytes: number
  /** All response bodies of one run together, so what the script keeps fits the engine's memory. */
  runResponseMaxBytes: number
  requestBodyMaxBytes: number
  timeoutMs: number
  /** Development and test servers only: lets a poller reach this machine. */
  allowLoopback?: boolean
  /** Refuse plain http on every hop, redirects included, as mods' requests do. */
  httpsOnly?: boolean
  /** Test servers only: names it matches reach the fake upstream on this machine's port. */
  testUpstream?: { matches: (hostname: string) => boolean; port: number } | null
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>
}

const REDIRECTS = 5
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
const FORBIDDEN_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-connection',
])
const USER_AGENT = 'Seti-Poller/1'

const stringMap = z.record(z.string().max(200), z.string().max(8192))

const requestSchema = z.object({
  url: z.string().max(8192),
  init: z
    .object({
      method: z
        .string()
        .transform((method) => method.toUpperCase())
        .pipe(z.enum(METHODS))
        .optional(),
      headers: stringMap.optional(),
      body: z.string().optional(),
      secretHeaders: stringMap.optional(),
      secretQuery: stringMap.optional(),
    })
    .loose(),
})

/* eslint-disable sonarjs/no-hardcoded-ip -- the address ranges no poller may reach */
/** Ranges no poller reaches: this machine, private networks, link-local, CGNAT and the like. */
const BLOCKED = new net.BlockList()
for (const [prefix, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(prefix, bits, 'ipv4')
}
for (const [prefix, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(prefix, bits, 'ipv6')
}
/* eslint-enable sonarjs/no-hardcoded-ip -- only the ranges above need it */

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i

const isLoopback = (address: string) => address.startsWith('127.') || address === '::1'

/** Why an address is off limits, or null when a poller may connect to it. */
export function addressProblem(address: string, allowLoopback = false): string | null {
  const mapped = MAPPED_V4.exec(address)?.[1]
  const plain = mapped ?? address
  const family = net.isIP(plain)
  if (family === 0) {
    return `${address} is not an IP address`
  }
  if (allowLoopback && isLoopback(plain)) {
    return null
  }
  const blocked = BLOCKED.check(plain, family === 4 ? 'ipv4' : 'ipv6')
  return blocked ? `${address} is a private or local address` : null
}

async function systemLookup(host: string): Promise<{ address: string; family: number }[]> {
  return dns.lookup(host, { all: true, order: 'verbatim' })
}

class PollFetchError extends Error {}

/** Replaces every secret value in text, so a service that echoes a header gives nothing away. */
export function redactValues(text: string, values: readonly string[]): string {
  return values.reduce((out, value) => (value === '' ? out : out.split(value).join('[secret]')), text)
}

const PLACEHOLDER = /\{\{\s*([a-z0-9_:-]+)\s*\}\}/gi

function fill(template: string, secrets: ReadonlyMap<string, string>): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = secrets.get(name.toLowerCase())
    if (value === undefined) {
      throw new PollFetchError(`The secret ${name} is not given to this poller; add it in its settings`)
    }
    return value
  })
}

interface Hop {
  url: URL
  method: (typeof METHODS)[number]
  headers: Record<string, string>
  body: string | undefined
}

interface Raw {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

async function send(hop: Hop, address: string, config: PollFetchConfig, signal: AbortSignal): Promise<Raw> {
  const client = hop.url.protocol === 'https:' ? https : http
  const hostname = hop.url.hostname.replace(/^\[|\]$/g, '')
  return new Promise<Raw>((resolve, reject) => {
    const upstream = config.testUpstream?.matches(hostname) === true ? config.testUpstream.port : null
    const request = client.request({
      host: address,
      port: upstream ?? (hop.url.port === '' ? undefined : Number(hop.url.port)),
      path: `${hop.url.pathname}${hop.url.search}`,
      method: hop.method,
      headers: { ...hop.headers, host: hop.url.host },
      ...(hop.url.protocol === 'https:' && net.isIP(hostname) === 0 ? { servername: hostname } : {}),
      signal,
      timeout: config.timeoutMs,
    })
    request.on('timeout', () => {
      request.destroy(new PollFetchError(`${hop.url.host} did not answer within ${String(config.timeoutMs)} ms`))
    })
    request.on('error', reject)
    request.on('response', (response) => {
      const declared = Number(response.headers['content-length'] ?? 0)
      const chunks: Buffer[] = []
      let size = 0
      const tooLarge = () =>
        new PollFetchError(`The response is over ${String(Math.round(config.responseMaxBytes / 1024 / 1024))} MB`)
      if (declared > config.responseMaxBytes) {
        response.destroy()
        reject(tooLarge())
        return
      }
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > config.responseMaxBytes) {
          response.destroy()
          reject(tooLarge())
          return
        }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) })
      })
    })
    request.end(hop.body)
  })
}

/** The one address a request goes to: every address the name has must be public. */
async function addressFor(url: URL, config: PollFetchConfig): Promise<string> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (config.testUpstream?.matches(hostname) === true) {
    return '127.0.0.1'
  }
  const literal = net.isIP(hostname) !== 0
  const addresses = literal ? [{ address: hostname, family: 0 }] : await (config.lookup ?? systemLookup)(hostname)
  const first = addresses[0]
  if (first === undefined) {
    throw new PollFetchError(`${hostname} has no address`)
  }
  for (const { address } of addresses) {
    const problem = addressProblem(address, config.allowLoopback === true)
    if (problem !== null) {
      throw new PollFetchError(`${hostname} is refused: ${problem}`)
    }
  }
  return first.address
}

function checkUrl(url: URL, config: PollFetchConfig): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PollFetchError(`Only http and https URLs are fetched, not ${url.protocol}`)
  }
  if (url.protocol === 'http:' && config.httpsOnly === true) {
    throw new PollFetchError(`${url.host} is refused: only https URLs are fetched here`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new PollFetchError('Put credentials in secretHeaders, not in the URL')
  }
  if (!urlAllowed(url.toString(), config.allowed)) {
    throw new PollFetchError(
      `${url.host} is not on the allowed hosts: add it to the poller's extra hosts or the sandbox allowlist`,
    )
  }
}

function plainHeaders(given: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: '*/*' }
  for (const [name, value] of Object.entries(given)) {
    const key = name.toLowerCase()
    if (FORBIDDEN_HEADERS.has(key) || !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(key) || /[\r\n]/.test(value)) {
      throw new PollFetchError(`The header ${name} cannot be set`)
    }
    headers[key] = value
  }
  return headers
}

function responseHeaders(headers: http.IncomingHttpHeaders, secrets: readonly string[]): [string, string][] {
  return Object.entries(headers).flatMap(([name, value]) => {
    const values = Array.isArray(value) ? value : [value ?? '']
    return values.map((entry): [string, string] => [name, redactValues(entry, secrets)])
  })
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** The first request, with secrets filled into its query and headers. */
function firstHop(request: z.output<typeof requestSchema>, config: PollFetchConfig): Hop {
  const { url: given, init } = request
  if (!URL.canParse(given)) {
    throw new PollFetchError('fetch needs an absolute http or https URL')
  }
  const url = new URL(given)
  for (const [name, template] of Object.entries(init.secretQuery ?? {})) {
    url.searchParams.set(name, fill(template, config.secrets))
  }
  if (init.body !== undefined && Buffer.byteLength(init.body) > config.requestBodyMaxBytes) {
    throw new PollFetchError(`The request body is over ${String(config.requestBodyMaxBytes / 1024)} KB`)
  }
  const secretHeaders = Object.entries(init.secretHeaders ?? {}).map(([name, template]): [string, string] => [
    name,
    fill(template, config.secrets),
  ])
  const headers = plainHeaders({ ...(init.headers ?? {}), ...Object.fromEntries(secretHeaders) })
  return { url, method: init.method ?? 'GET', headers, body: init.body }
}

/** The origin the script named, and the headers that carry secrets to it. */
interface SecretScope {
  origin: string
  headers: ReadonlySet<string>
}

/** Where a redirect leads, as a browser follows it; secret headers go only to the first origin. */
function nextHop(hop: Hop, redirect: { location: string; status: number }, secrets: SecretScope): Hop {
  const { location, status } = redirect
  const { origin, headers: secretHeaders } = secrets
  const url = new URL(location, hop.url)
  const toGet = status === 303 || ((status === 301 || status === 302) && hop.method === 'POST')
  const kept = Object.entries(hop.headers).filter(
    ([name]) => (url.origin === origin || !secretHeaders.has(name)) && !(toGet && name === 'content-type'),
  )
  return {
    url,
    method: toGet ? 'GET' : hop.method,
    headers: Object.fromEntries(kept),
    body: toGet ? undefined : hop.body,
  }
}

/** A poll script's fetch: allowlisted hosts on public addresses, secrets filled in by Seti. */
export function createPollFetch(config: PollFetchConfig) {
  const values = [...config.secrets.values()]
  const redacted = (text: string) => redactValues(text, values)
  let received = 0
  return async (request: unknown, signal: AbortSignal): Promise<PollResponse> => {
    const parsed = requestSchema.safeParse(request)
    if (!parsed.success) {
      throw new PollFetchError('fetch takes a URL and { method, headers, body, secretHeaders, secretQuery }')
    }
    let hop = firstHop(parsed.data, config)
    const names = Object.keys(parsed.data.init.secretHeaders ?? {}).map((name) => name.toLowerCase())
    const scope: SecretScope = { origin: hop.url.origin, headers: new Set(names) }
    for (let redirects = 0; ; redirects++) {
      checkUrl(hop.url, config)
      const current = hop
      const raw = await send(current, await addressFor(current.url, config), config, signal).catch((e: unknown) => {
        throw new PollFetchError(redacted(`${current.url.host}: ${e instanceof Error ? e.message : String(e)}`))
      })
      received += raw.body.length
      if (received > config.runResponseMaxBytes) {
        const limit = String(Math.round(config.runResponseMaxBytes / 1024 / 1024))
        throw new PollFetchError(`The responses of one run are over ${limit} MB together`)
      }
      const location = raw.headers.location
      if (!REDIRECT_STATUSES.has(raw.status) || location === undefined) {
        return {
          status: raw.status,
          url: redacted(current.url.toString()),
          headers: responseHeaders(raw.headers, values),
          body: redacted(new TextDecoder().decode(raw.body)),
        }
      }
      if (redirects >= REDIRECTS) {
        throw new PollFetchError(`Over ${String(REDIRECTS)} redirects`)
      }
      hop = nextHop(current, { location, status: raw.status }, scope)
    }
  }
}
