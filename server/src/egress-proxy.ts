import fs from 'node:fs'
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http'
import https from 'node:https'
import type { Duplex } from 'node:stream'
import tls from 'node:tls'
import { urlAllowed } from '@seti/shared'
import {
  answer,
  connectorOff,
  NO_CLAUDE_CREDENTIAL,
  parseAuthority,
  refuseSocket,
  type Target,
} from './egress-answers.js'
import { isAwsCredentialsPath, isAwsHost, serveAwsCredentials, type EgressAws } from './egress-aws.js'
import {
  ANTHROPIC_HOST,
  ANTHROPIC_HOSTS,
  builtinCredential,
  connectorOf,
  directAddress,
  type EgressCredentials,
  injectCredentials,
  INTERCEPTED_HOSTS,
  isGitHub,
  withoutHopByHop,
} from './egress-hosts.js'
import {
  keyRequest,
  placeholderAllowed,
  type EgressPlaceholder,
  type Keyed,
  type Refusal,
} from './egress-placeholders.js'
import { relayUpgrade, tunnel } from './egress-relay.js'
import { relayRenewing } from './egress-replay.js'
import { applyRules, ruleCovers, type Applied, type EgressRule } from './egress-rules.js'
import type { SandboxCa } from './sandbox-ca.js'

/** Where connections for a host really go; tests point them at local fakes. */
interface Upstream {
  address: (host: string, port: number) => Promise<Target>
  tls?: tls.ConnectionOptions
}

export interface EgressOptions {
  socketPath: string
  /** The allowlist in force, read for every new connection so edits apply at once. */
  allowed: () => Promise<readonly string[]>
  ca: SandboxCa
  credentials: EgressCredentials
  /**
   * Headers for other hosts, such as MCP sign-ins and the task's connections: their hosts
   * are allowed on their port and intercepted so the proxy can set them.
   */
  rules?: () => readonly EgressRule[]
  /** The task's connections as placeholders: their hosts are allowed and intercepted like rules'. */
  placeholders?: () => readonly EgressPlaceholder[]
  /** A request carried placeholders toward a host their keys do not allow, and was refused. */
  onBlocked?: (host: string, names: readonly string[]) => void
  /** Whether the task may use a claude.ai connector, by its id; every one when left out. */
  connectorAllowed?: (id: string) => boolean
  /** The task's AWS: its credentials endpoint and AWS hosts, while the task has it on. */
  aws?: EgressAws
  /** Whether the task may reach host:port for ssh: the first hop of one of its ssh hosts. */
  ssh?: (authority: string) => Promise<boolean>
  onRefused?: (host: string) => void
  upstream?: Upstream
}

export interface EgressProxy {
  socketPath: string
  close: () => Promise<void>
}

const DIRECT: Upstream = { address: directAddress }

interface Outgoing {
  headers: OutgoingHttpHeaders
  applied: Applied[]
  url: URL | null
}

/** Why a host was refused, in the words a command's error output shows the agent. */
export const refusalText = (host: string) =>
  `Seti sandbox: ${host} is not on the allowed hosts list. Ask the user to add it in Settings, Sandbox.`

/** One HTTP proxy per sandboxed task, on a unix socket only that task's sandbox mounts. */
class Egress {
  private readonly options: EgressOptions
  private readonly upstream: Upstream
  private readonly agent = new https.Agent({ keepAlive: true })
  private readonly interceptedTarget = new WeakMap<object, Target>()
  private readonly tunnels = new Set<Duplex>()
  private readonly server: http.Server
  private readonly intercepted: http.Server

  constructor(options: EgressOptions) {
    this.options = options
    this.upstream = options.upstream ?? DIRECT
    this.server = http.createServer({ requestTimeout: 0 }, (req, res) => {
      void this.onRequest(req, res)
    })
    this.intercepted = http.createServer({ requestTimeout: 0 }, (req, res) => {
      this.onIntercepted(req, res)
    })
    this.intercepted.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.onUpgrade(req, socket, head)
    })
    this.server.on('connect', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.onConnect(req, socket, head)
    })
    for (const server of [this.server, this.intercepted]) {
      server.on('clientError', (_e, socket) => {
        socket.destroy()
      })
    }
  }

  async listen(): Promise<void> {
    fs.rmSync(this.options.socketPath, { force: true })
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.options.socketPath, () => {
        this.server.off('error', reject)
        resolve()
      })
    })
  }

  async close(): Promise<void> {
    this.agent.destroy()
    for (const socket of this.tunnels) {
      socket.destroy()
    }
    this.server.closeAllConnections()
    this.intercepted.closeAllConnections()
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve()
      })
    })
    fs.rmSync(this.options.socketPath, { force: true })
  }

  private rulesFor(target: Target): EgressRule[] {
    try {
      return (this.options.rules?.() ?? []).filter((rule) => ruleCovers(rule, target.host, target.port))
    } catch {
      return []
    }
  }

  private placeholders(): readonly EgressPlaceholder[] {
    try {
      return this.options.placeholders?.() ?? []
    } catch {
      return []
    }
  }

  private async withKeys(target: Target, path: string, headers: IncomingHttpHeaders): Promise<Keyed | Refusal> {
    return keyRequest({ target, path, headers }, this.placeholders(), this.options.onBlocked)
  }

  private hasRule(target: Target): boolean {
    return (
      this.rulesFor(target).length > 0 ||
      this.placeholders().some((entry) => placeholderAllowed(entry, target.host, target.port))
    )
  }

  /** Unreadable settings allow nothing but Claude, so the proxy fails closed. */
  private async allowed(target: Target): Promise<boolean> {
    if ((target.port === 443 && ANTHROPIC_HOSTS.includes(target.host)) || this.hasRule(target)) {
      return true
    }
    const { aws, ssh } = this.options
    if (aws !== undefined && target.port === 443 && isAwsHost(target.host)) {
      return aws.enabled().catch(() => false)
    }
    if (ssh !== undefined && (await ssh(`${target.host}:${String(target.port)}`).catch(() => false))) {
      return true
    }
    const allowed = await this.options.allowed().catch(() => [])
    return urlAllowed(`https://${target.host}:${String(target.port)}/`, allowed)
  }

  private refused(host: string): string {
    this.options.onRefused?.(host)
    return refusalText(host)
  }

  /** Origin-form requests are Claude API calls through ANTHROPIC_BASE_URL; others plain HTTP. */
  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/'
    if (isAwsCredentialsPath(url)) {
      await serveAwsCredentials(req, res, this.options.aws)
      return
    }
    if (url.startsWith('/')) {
      await this.forward({ host: ANTHROPIC_HOST, port: 443 }, req, res)
      return
    }
    if (!URL.canParse(url) || new URL(url).protocol !== 'http:') {
      answer(res, 400, 'Seti sandbox proxy: send https through CONNECT')
      return
    }
    const parsed = new URL(url)
    const target = { host: parsed.hostname.toLowerCase(), port: Number(parsed.port === '' ? '80' : parsed.port) }
    if (!(await this.allowed(target))) {
      answer(res, 403, this.refused(target.host))
      return
    }
    const keyed = await this.withKeys(target, `${parsed.pathname}${parsed.search}`, req.headers)
    if ('status' in keyed) {
      answer(res, keyed.status, keyed.body)
      req.resume()
      return
    }
    const address = await this.reach(target)
    if (address instanceof Error) {
      answer(res, 502, address.message)
      return
    }
    const out = http.request({
      host: address.host,
      port: address.port,
      method: req.method,
      path: keyed.path,
      headers: { ...withoutHopByHop(keyed.headers), host: parsed.host },
    })
    this.relay(target.host, req, res, out)
  }

  private onIntercepted(req: IncomingMessage, res: ServerResponse): void {
    const target = this.interceptedTarget.get(req.socket)
    if (target === undefined) {
      answer(res, 400, 'Seti sandbox proxy: unknown connection')
      return
    }
    void this.forward(target, req, res)
  }

  /** WebSocket handshakes on intercepted hosts get the same keys, credentials and checks. */
  private async onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on('error', () => {
      socket.destroy()
    })
    const target = this.interceptedTarget.get(req.socket)
    if (target === undefined) {
      refuseSocket(socket, 400, 'Bad Request', 'Seti sandbox proxy: unknown connection')
      return
    }
    const keyed = await this.withKeys(target, req.url ?? '/', req.headers)
    if ('status' in keyed) {
      refuseSocket(socket, keyed.status, keyed.reason, keyed.body)
      return
    }
    const prepared = await this.outgoing(target, keyed)
    const address = prepared === null ? new Error('Seti has no Claude credential') : await this.reach(target)
    if (prepared === null || address instanceof Error) {
      refuseSocket(socket, 502, 'Bad Gateway', address instanceof Error ? address.message : 'Seti sandbox proxy')
      return
    }
    const upgrade = { connection: 'Upgrade', upgrade: req.headers.upgrade ?? 'websocket' }
    const out = https.request({
      ...this.upstream.tls,
      host: address.host,
      port: address.port,
      servername: target.host,
      method: req.method,
      path: keyed.path,
      headers: { ...prepared.headers, ...upgrade },
      agent: false,
    })
    relayUpgrade(target.host, socket, head, out)
  }

  private async reach(target: Target): Promise<Target | Error> {
    try {
      return await this.upstream.address(target.host, target.port)
    } catch (e) {
      return new Error(
        `Seti sandbox proxy could not reach ${target.host}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  /** Seti's own token on its hosts, else the task's connection headers; null without Claude's. */
  private async outgoing(target: Target, keyed: Keyed): Promise<Outgoing | null> {
    const builtin = ANTHROPIC_HOSTS.includes(target.host) || isGitHub(target.host)
    const injected = builtin
      ? injectCredentials(
          target.host,
          keyed.headers,
          await builtinCredential(this.options.credentials, target.host, keyed.path),
        )
      : withoutHopByHop(keyed.headers)
    if (injected === null) {
      return null
    }
    const origin = `https://${target.host}:${String(target.port)}`
    const url = keyed.path.startsWith('/') && URL.canParse(keyed.path, origin) ? new URL(keyed.path, origin) : null
    const { headers, applied } = builtin
      ? { headers: injected, applied: [] }
      : await applyRules(this.rulesFor(target), url, injected)
    headers.host = target.port === 443 ? target.host : `${target.host}:${String(target.port)}`
    return { headers, applied, url }
  }

  private async forward(target: Target, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const keyed = await this.withKeys(target, req.url ?? '/', req.headers)
    if ('status' in keyed) {
      answer(res, keyed.status, keyed.body)
      req.resume()
      return
    }
    const connector = connectorOf(target.host, keyed.path)
    if (connector !== null && this.options.connectorAllowed?.(connector) === false) {
      answer(res, 403, connectorOff(connector), 'application/json')
      req.resume()
      return
    }
    const prepared = await this.outgoing(target, keyed)
    if (prepared === null) {
      answer(res, 401, NO_CLAUDE_CREDENTIAL, 'application/json')
      req.resume()
      return
    }
    const { headers, applied, url } = prepared
    const address = await this.reach(target)
    if (address instanceof Error) {
      answer(res, 502, address.message)
      req.resume()
      return
    }
    const send = (sent: OutgoingHttpHeaders) =>
      https.request({
        ...this.upstream.tls,
        host: address.host,
        port: address.port,
        servername: target.host,
        method: req.method,
        path: keyed.path,
        headers: sent,
        agent: this.agent,
      })
    const renewable = applied.filter((entry) => entry.rule.renew !== undefined)
    if (renewable.length === 0 || url === null) {
      this.relay(target.host, req, res, send(headers))
      return
    }
    await relayRenewing({
      host: target.host,
      url,
      req,
      res,
      headers,
      renewable,
      send,
      answer: (status, body) => {
        answer(res, status, body)
      },
    })
  }

  private relay(host: string, req: IncomingMessage, res: ServerResponse, out: http.ClientRequest): void {
    out.on('response', (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, withoutHopByHop(upstream.headers))
      upstream.pipe(res)
    })
    out.on('error', (e) => {
      answer(res, 502, `Seti sandbox proxy could not reach ${host}: ${e.message}`)
    })
    res.on('close', () => {
      if (!res.writableFinished) {
        out.destroy()
      }
    })
    req.pipe(out)
  }

  private async onConnect(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    this.tunnels.add(socket)
    socket.on('error', () => {
      socket.destroy()
    })
    socket.on('close', () => {
      this.tunnels.delete(socket)
    })
    const target = parseAuthority(req.url ?? '')
    if (target === null) {
      refuseSocket(socket, 400, 'Bad Request', 'Seti sandbox proxy: CONNECT needs host:port')
      return
    }
    if (!(await this.allowed(target))) {
      refuseSocket(socket, 403, 'Forbidden', this.refused(target.host))
      return
    }
    const intercepted = (target.port === 443 && INTERCEPTED_HOSTS.includes(target.host)) || this.hasRule(target)
    if (intercepted && this.options.ca.covers(target.host)) {
      await this.intercept(target, socket, head)
      return
    }
    tunnel(target.host, await this.reach(target), socket, head)
  }

  private async intercept(target: Target, socket: Duplex, head: Buffer): Promise<void> {
    let secureContext: tls.SecureContext
    try {
      secureContext = await this.options.ca.contextFor(target.host)
    } catch {
      refuseSocket(socket, 502, 'Bad Gateway', `Seti sandbox proxy has no certificate for ${target.host}`)
      return
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length > 0) {
      socket.unshift(head)
    }
    const secure = new tls.TLSSocket(socket, {
      isServer: true,
      secureContext,
      ALPNProtocols: ['http/1.1'],
    })
    secure.on('error', () => {
      secure.destroy()
    })
    this.interceptedTarget.set(secure, target)
    this.intercepted.emit('connection', secure)
  }
}

/** Starts the egress proxy on its unix socket; resolves once it accepts connections. */
export async function startEgressProxy(options: EgressOptions): Promise<EgressProxy> {
  const egress = new Egress(options)
  await egress.listen()
  return { socketPath: options.socketPath, close: async () => egress.close() }
}
