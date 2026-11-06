import fs from 'node:fs'
import http, { type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http'
import https from 'node:https'
import net, { type AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import tls from 'node:tls'
import { AWS_CREDENTIALS_PATH, mintSettingsInput } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ContainerCredentials } from './aws-credentials.js'
import { connectionRule } from './connection-egress.js'
import type { EgressAws } from './egress-aws.js'
import {
  ANTHROPIC_HOST,
  connectorOf,
  directAddress,
  githubOwnerOf,
  type EgressCredentials,
  injectCredentials,
  MCP_PROXY_HOST,
} from './egress-hosts.js'
import { swapPlaceholders, type EgressPlaceholder } from './egress-placeholders.js'
import { refusalText, startEgressProxy, type EgressOptions, type EgressProxy } from './egress-proxy.js'
import type { EgressRule } from './egress-rules.js'
import type { McpTokens } from './mcp-oauth.js'
import { loadSandboxCa, type SandboxCa } from './sandbox-ca.js'
import { mcpLoginRules } from './task-credentials.js'
import { createTokenMinter } from './token-minter.js'

const CLAUDE = ['sk', 'ant', 'oat01', 'fake-claude'].join('-')
const GITHUB = ['github', 'pat', 'fake0123'].join('_')
const OWNER_TOKEN = ['github', 'pat', 'owner0456'].join('_')
const CONNECTOR = ['sk', 'ant', 'oat01', 'fake-login'].join('-')
const MCP = ['mcp', 'access', 'fake'].join('-')
const MCP_HOST = 'mcp.example.test'
const PLACEHOLDER = 'placeholder'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-egress-'))
let ca: SandboxCa
let caPem: string
let upstream: https.Server
let echo: net.Server
const refused: string[] = []

interface Seen {
  status: number
  host: string | undefined
  path: string | undefined
  authorization: string | undefined
  apiKey: string | undefined
  body: string
}

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

let upstreamPort = 0
let proxies = 0
let echoPort = 0

/** The host's sign-in to one MCP server, as the shared rule path turns it into a rule. */
const mcpLogins: McpTokens = {
  logins: () => [
    {
      key: 'tracker|1',
      name: 'tracker',
      url: new URL(`https://${MCP_HOST}/mcp`),
      accessToken: MCP,
      refreshToken: undefined,
      expiresAt: undefined,
      clientId: undefined,
      clientSecret: undefined,
      authorizationServer: undefined,
      metadataUrl: undefined,
    },
  ],
  tokenFor: async (url) => mcpToken(url),
  state: () => 'ok',
}

async function proxy(
  allowed: () => Promise<readonly string[]>,
  credentials: EgressCredentials,
  rules: readonly EgressRule[] = [],
  extra: Partial<EgressOptions> = {},
): Promise<EgressProxy> {
  return startEgressProxy({
    rules: () => rules,
    ...extra,
    socketPath: path.join(dir, `proxy-${String(++proxies)}.sock`),
    allowed,
    ca,
    credentials,
    onRefused: (host) => refused.push(host),
    upstream: {
      address: async (host) =>
        Promise.resolve({ host: '127.0.0.1', port: host.endsWith('.tunnel.test') ? echoPort : upstreamPort }),
      tls: { ca: caPem },
    },
  })
}

const token = (value: string | null) => async () => Promise.resolve(value)
const mcpToken = async (url: URL) => Promise.resolve(url.pathname.startsWith('/mcp') ? MCP : null)
const both: EgressCredentials = {
  claude: token(CLAUDE),
  github: token(GITHUB),
  connector: token(CONNECTOR),
}
const allowAll = async () => Promise.resolve(['github.com', 'api.github.com', '*.tunnel.test', 'plain.test'])

async function readBody(res: http.IncomingMessage): Promise<string> {
  let text = ''
  for await (const chunk of res) {
    text += String(chunk)
  }
  return text
}

async function viaSocket(
  socketPath: string,
  options: http.RequestOptions,
  body = '',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, ...options }, (res) => {
      void readBody(res).then((text) => {
        resolve({ status: res.statusCode ?? 0, body: text })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function connect(socketPath: string, authority: string): Promise<{ status: number; socket: Duplex }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method: 'CONNECT', path: authority })
    req.on('connect', (res, socket) => {
      resolve({ status: res.statusCode ?? 0, socket })
    })
    req.on('error', reject)
    req.end()
  })
}

/** The status a CONNECT to `authority` gets; the tunnel is closed at once. */
async function connectStatus(running: EgressProxy, authority: string): Promise<number> {
  const result = await connect(running.socketPath, authority)
  result.socket.destroy()
  return result.status
}

/** An HTTPS request to `host` through the proxy's TLS interception. */
async function throughTunnel(
  socketPath: string,
  host: string,
  headers: OutgoingHttpHeaders,
  requestPath = '/user',
): Promise<Seen> {
  const { status, socket } = await connect(socketPath, `${host}:443`)
  expect(status).toBe(200)
  const secure = tls.connect({ socket, servername: host, ca: caPem })
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host, path: requestPath, method: 'POST', headers, createConnection: () => secure },
      (res) => {
        void readBody(res).then((text) => {
          resolve(JSON.parse(text) as Seen)
        })
      },
    )
    req.on('error', reject)
    req.end('hello')
  })
}

/** An HTTPS request through the proxy's interception, as status and raw body. */
async function rawThroughTunnel(
  socketPath: string,
  host: string,
  headers: OutgoingHttpHeaders,
  requestPath: string,
): Promise<{ status: number; body: string }> {
  const { status, socket } = await connect(socketPath, `${host}:443`)
  expect(status).toBe(200)
  const secure = tls.connect({ socket, servername: host, ca: caPem })
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host, path: requestPath, method: 'GET', headers, createConnection: () => secure },
      (res) => {
        void readBody(res).then((body) => {
          resolve({ status: res.statusCode ?? 0, body })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/** A WebSocket handshake through the proxy: the 101 headers upstream echoed, or the refusal. */
async function upgradeThroughTunnel(
  socketPath: string,
  host: string,
  headers: OutgoingHttpHeaders,
  requestPath: string,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  const { status, socket } = await connect(socketPath, `${host}:443`)
  expect(status).toBe(200)
  const secure = tls.connect({ socket, servername: host, ca: caPem })
  const upgrade = { ...headers, connection: 'Upgrade', upgrade: 'websocket' }
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path: requestPath, headers: upgrade, createConnection: () => secure })
    req.on('upgrade', (res, upgraded) => {
      upgraded.destroy()
      resolve({ status: res.statusCode ?? 0, headers: res.headers, body: '' })
    })
    req.on('response', (res) => {
      void readBody(res).then((body) => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

beforeAll(async () => {
  ca = await loadSandboxCa(path.join(dir, 'ca'))
  expect(await ca.cover([MCP_HOST, 'github.com'])).toBe(true)
  expect(await ca.cover([MCP_HOST])).toBe(false)
  expect(await ca.cover(['rules.test'])).toBe(true)
  caPem = fs.readFileSync(path.join(ca.publicDir, 'ca.pem'), 'utf8')
  upstream = https.createServer(
    {
      SNICallback: (name, done) => {
        ca.contextFor(name).then(
          (context) => {
            done(null, context)
          },
          (e: unknown) => {
            done(e instanceof Error ? e : new Error(String(e)))
          },
        )
      },
    },
    (req, res) => {
      void readBody(req).then((body) => {
        const strict = req.url === '/strict' && req.headers.authorization !== 'Bearer fresh-token'
        const seen: Seen = {
          status: strict ? 401 : 200,
          host: req.headers.host,
          path: req.url,
          authorization: req.headers.authorization,
          apiKey: req.headers['x-api-key'] as string | undefined,
          body,
        }
        res.writeHead(seen.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(seen))
      })
    },
  )
  upstream.on('upgrade', (req: http.IncomingMessage, socket: Duplex) => {
    const key = String(req.headers['x-api-key'] ?? '')
    socket.end(
      'HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n' +
        `x-seen-key: ${key}\r\nx-seen-path: ${req.url ?? ''}\r\n\r\n`,
    )
  })
  upstreamPort = await listen(upstream)
  echo = net.createServer((socket) => socket.pipe(socket))
  echoPort = await listen(echo)
})

afterAll(() => {
  upstream.close()
  echo.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('injectCredentials', () => {
  const headers: IncomingHttpHeaders = {
    authorization: `token ${PLACEHOLDER}`,
    'x-api-key': PLACEHOLDER,
    connection: 'x',
  }

  it('puts the Claude token on Anthropic requests in place of any key the sandbox sent', () => {
    expect(injectCredentials(ANTHROPIC_HOST, headers, CLAUDE)).toEqual({ authorization: `Bearer ${CLAUDE}` })
    expect(injectCredentials(ANTHROPIC_HOST, headers, null)).toBeNull()
  })

  it('uses the fine-grained token on GitHub, as Basic for git and Bearer for the API', () => {
    const basic = Buffer.from(`x-access-token:${GITHUB}`).toString('base64')
    expect(injectCredentials('github.com', headers, GITHUB)?.authorization).toBe(`Basic ${basic}`)
    expect(injectCredentials('api.github.com', headers, GITHUB)?.authorization).toBe(`Bearer ${GITHUB}`)
    expect(injectCredentials('uploads.github.com', headers, GITHUB)?.authorization).toBe(`Bearer ${GITHUB}`)
  })

  it('refuses a request to the MCP proxy without a credential', () => {
    expect(injectCredentials(MCP_PROXY_HOST, headers, null)).toBeNull()
  })

  it('sends GitHub requests unauthenticated without a token, dropping whatever the sandbox sent', () => {
    const out = injectCredentials('api.github.com', headers, null)
    expect(out?.authorization).toBeUndefined()
    expect(out?.connection).toBeUndefined()
  })
})

describe('githubOwnerOf', () => {
  it('reads the owner from git paths on github.com and repo, org and user paths on the API', () => {
    expect(githubOwnerOf('github.com', '/Octocat/seti.git/info/refs?service=git-upload-pack')).toBe('octocat')
    expect(githubOwnerOf('api.github.com', '/repos/globex-ops/infra/pulls?state=open')).toBe('globex-ops')
    expect(githubOwnerOf('api.github.com', '/orgs/globex/repos')).toBe('globex')
    expect(githubOwnerOf('api.github.com', '/users/Octocat')).toBe('octocat')
    expect(githubOwnerOf('uploads.github.com', '/repos/Octocat/vllm/releases/1/assets')).toBe('octocat')
  })

  it('names no owner for account-wide requests and malformed names', () => {
    for (const requestPath of ['/user', '/graphql', '/search/issues?q=x', '/repos', '/']) {
      expect(githubOwnerOf('api.github.com', requestPath)).toBeNull()
    }
    expect(githubOwnerOf('github.com', '/-bad-/repo.git')).toBeNull()
    expect(githubOwnerOf('api.github.com', '/repos/a--b/x')).toBeNull()
  })
})

describe('directAddress', () => {
  it('connects to addresses and localhost named outright', async () => {
    expect(await directAddress('127.0.0.1', 80)).toEqual({ host: '127.0.0.1', port: 80 })
    expect(await directAddress('localhost', 3000)).toEqual({ host: 'localhost', port: 3000 })
  })

  /* eslint-disable sonarjs/no-hardcoded-ip -- the addresses a fake resolver answers with */
  it('refuses names that resolve to this machine or its metadata service', async () => {
    const resolvesTo = (address: string) => async () => Promise.resolve({ address })
    for (const address of ['127.0.0.2', '0.0.0.0', '169.254.169.254', '::1', 'fe80::1', '::ffff:127.0.0.1']) {
      await expect(directAddress('rebound.example', 443, resolvesTo(address))).rejects.toThrow(/on this machine/)
    }
    const github = '140.82.112.3'
    expect(await directAddress('github.com', 443, resolvesTo(github))).toEqual({ host: github, port: 443 })
  })
  /* eslint-enable sonarjs/no-hardcoded-ip -- only the fake resolver answers need it */
})

describe('egress proxy', () => {
  it('forwards Claude API calls from ANTHROPIC_BASE_URL with the real credential', async () => {
    const running = await proxy(allowAll, both)
    const res = await viaSocket(
      running.socketPath,
      { method: 'POST', path: '/v1/messages?beta=true', headers: { authorization: `Bearer ${PLACEHOLDER}` } },
      '{"model":"x"}',
    )
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      status: 200,
      host: ANTHROPIC_HOST,
      path: '/v1/messages?beta=true',
      authorization: `Bearer ${CLAUDE}`,
      body: '{"model":"x"}',
    })
    await running.close()
  })

  it('answers Claude calls with an authentication error when Seti has no credential', async () => {
    const running = await proxy(allowAll, { ...both, claude: token(null) })
    const res = await viaSocket(running.socketPath, { method: 'POST', path: '/v1/messages' }, '{}')
    expect(res.status).toBe(401)
    expect(res.body).toContain('Seti has no Claude credential')
    await running.close()
  })

  it('refuses CONNECT to hosts outside the allowlist with a reason', async () => {
    const running = await proxy(allowAll, both)
    const { status, socket } = await connect(running.socketPath, 'example.com:443')
    expect(status).toBe(403)
    socket.destroy()
    expect(refused).toContain('example.com')
    const plain = await viaSocket(running.socketPath, { path: 'http://example.com/', headers: { host: 'example.com' } })
    expect(plain).toEqual({ status: 403, body: refusalText('example.com') })
    await running.close()
  })

  it('tunnels allowed hosts it does not intercept byte for byte', async () => {
    const running = await proxy(allowAll, both)
    const { status, socket } = await connect(running.socketPath, 'registry.tunnel.test:443')
    expect(status).toBe(200)
    const reply = new Promise<string>((resolve) =>
      socket.once('data', (chunk: Buffer) => {
        resolve(chunk.toString())
      }),
    )
    socket.write('ping')
    expect(await reply).toBe('ping')
    socket.destroy()
    await running.close()
  })

  it('terminates TLS for GitHub and swaps the placeholder for the token', async () => {
    const running = await proxy(allowAll, both)
    const api = await throughTunnel(running.socketPath, 'api.github.com', { authorization: `token ${PLACEHOLDER}` })
    expect(api).toMatchObject({ host: 'api.github.com', authorization: `Bearer ${GITHUB}`, body: 'hello' })
    const git = await throughTunnel(running.socketPath, 'github.com', {})
    const basic = Buffer.from(`x-access-token:${GITHUB}`).toString('base64')
    expect(git.authorization).toBe(`Basic ${basic}`)
    await running.close()
  })

  it("picks the GitHub token by the request's owner, and the default for requests without one", async () => {
    const asked: (string | null)[] = []
    const github = async (owner: string | null) => {
      asked.push(owner)
      return Promise.resolve(owner === 'octocat' ? OWNER_TOKEN : GITHUB)
    }
    const running = await proxy(allowAll, { ...both, github })
    const own = await throughTunnel(running.socketPath, 'api.github.com', {}, '/repos/Octocat/seti/pulls')
    expect(own.authorization).toBe(`Bearer ${OWNER_TOKEN}`)
    const clone = await throughTunnel(running.socketPath, 'github.com', {}, '/Octocat/seti.git/git-upload-pack')
    const basic = Buffer.from(`x-access-token:${OWNER_TOKEN}`).toString('base64')
    expect(clone.authorization).toBe(`Basic ${basic}`)
    const other = await throughTunnel(running.socketPath, 'api.github.com', {}, '/repos/globex/app/pulls')
    expect(other.authorization).toBe(`Bearer ${GITHUB}`)
    const graphql = await throughTunnel(running.socketPath, 'api.github.com', {}, '/graphql')
    expect(graphql.authorization).toBe(`Bearer ${GITHUB}`)
    expect(asked).toEqual(['octocat', 'octocat', 'globex', null])
    await running.close()
  })

  it('reaches GitHub unauthenticated when no token is configured', async () => {
    const running = await proxy(allowAll, { ...both, github: token(null) })
    const api = await throughTunnel(running.socketPath, 'api.github.com', { authorization: 'token ghp_agent_own' })
    expect(api.authorization).toBeUndefined()
    await running.close()
  })

  it('lets Claude through with the credential over CONNECT even with an empty allowlist', async () => {
    const running = await proxy(async () => Promise.resolve([]), both)
    const seen = await throughTunnel(running.socketPath, ANTHROPIC_HOST, { 'x-api-key': PLACEHOLDER })
    expect(seen.authorization).toBe(`Bearer ${CLAUDE}`)
    expect(seen.apiKey).toBeUndefined()
    const { status, socket } = await connect(running.socketPath, 'api.github.com:443')
    expect(status).toBe(403)
    socket.destroy()
    await running.close()
  })

  it("applies each task's own allowlist on its own socket, failing closed when it cannot read it", async () => {
    const first = await proxy(async () => Promise.resolve(['one.tunnel.test']), both)
    const second = await proxy(async () => Promise.resolve(['two.tunnel.test']), both)
    const broken = await proxy(async () => Promise.reject(new Error('database down')), both)
    const status = connectStatus
    expect(await status(first, 'one.tunnel.test:443')).toBe(200)
    expect(await status(first, 'two.tunnel.test:443')).toBe(403)
    expect(await status(second, 'two.tunnel.test:443')).toBe(200)
    expect(await status(second, 'one.tunnel.test:443')).toBe(403)
    expect(await status(broken, 'one.tunnel.test:443')).toBe(403)
    await Promise.all([first.close(), second.close(), broken.close()])
    expect(fs.existsSync(first.socketPath)).toBe(false)
  })

  it('adds the MCP token for a signed-in server, even off the allowlist, and only on its paths', async () => {
    const running = await proxy(async () => Promise.resolve([]), both, mcpLoginRules(new Set(), mcpLogins))
    const mcp = await throughTunnel(running.socketPath, MCP_HOST, { authorization: 'Bearer own' }, '/mcp')
    expect(mcp).toMatchObject({ host: MCP_HOST, path: '/mcp', authorization: `Bearer ${MCP}` })
    const other = await throughTunnel(running.socketPath, MCP_HOST, { authorization: 'Bearer own' }, '/other')
    expect(other.authorization).toBeUndefined()
    const { status, socket } = await connect(running.socketPath, `${MCP_HOST}:8443`)
    expect(status).toBe(403)
    socket.destroy()
    await running.close()
  })

  it('refuses a signed-in MCP host to a task whose proxy does not list it', async () => {
    const running = await proxy(async () => Promise.resolve([]), both)
    const { status, socket } = await connect(running.socketPath, `${MCP_HOST}:443`)
    expect(status).toBe(403)
    socket.destroy()
    await running.close()
  })

  it('reaches claude.ai connectors and the connector list with the host login, inference with Claude', async () => {
    const running = await proxy(async () => Promise.resolve([]), both)
    const connector = await throughTunnel(running.socketPath, MCP_PROXY_HOST, {}, '/v1/mcp/srv_1')
    expect(connector.authorization).toBe(`Bearer ${CONNECTOR}`)
    const list = await throughTunnel(running.socketPath, ANTHROPIC_HOST, {}, '/v1/mcp_servers?limit=1000')
    expect(list.authorization).toBe(`Bearer ${CONNECTOR}`)
    const inference = await throughTunnel(running.socketPath, ANTHROPIC_HOST, {}, '/v1/messages')
    expect(inference.authorization).toBe(`Bearer ${CLAUDE}`)
    await running.close()
    const tokenOnly = await proxy(async () => Promise.resolve([]), { ...both, connector: token(null) })
    const fallback = await throughTunnel(tokenOnly.socketPath, MCP_PROXY_HOST, {}, '/v1/mcp/srv_1')
    expect(fallback.authorization).toBe(`Bearer ${CLAUDE}`)
    await tokenOnly.close()
  })

  it('refuses a claude.ai connector the task turned off, and only that one', async () => {
    expect(connectorOf(MCP_PROXY_HOST, '/v1/mcp/srv_off/tools?x=1')).toBe('srv_off')
    expect(connectorOf(ANTHROPIC_HOST, '/v1/mcp/srv_off')).toBeNull()
    expect(connectorOf(MCP_PROXY_HOST, '/v1/other')).toBeNull()
    const running = await proxy(async () => Promise.resolve([]), both, [], {
      connectorAllowed: (id) => id !== 'srv_off',
    })
    const on = await throughTunnel(running.socketPath, MCP_PROXY_HOST, {}, '/v1/mcp/srv_on')
    expect(on).toMatchObject({ path: '/v1/mcp/srv_on', authorization: `Bearer ${CONNECTOR}` })
    const off: unknown = await throughTunnel(running.socketPath, MCP_PROXY_HOST, {}, '/v1/mcp/srv_off')
    expect(off).toEqual({ error: expect.stringContaining('srv_off is turned off for this agent') as unknown })
    await running.close()
  })

  it('refuses the host of a signed-in MCP server the task turned off', async () => {
    const off = await proxy(async () => Promise.resolve([]), both, mcpLoginRules(new Set(['tracker']), mcpLogins))
    expect(await connectStatus(off, `${MCP_HOST}:443`)).toBe(403)
    await off.close()
  })

  it("sets a rule's header on its hosts only, over what the sandbox sent, and keeps other headers", async () => {
    const rule: EgressRule = {
      hosts: ['*.rules.test'],
      port: 443,
      header: 'x-api-key',
      value: async () => Promise.resolve('rule-key-123'),
    }
    const running = await proxy(async () => Promise.resolve([]), both, [rule])
    const seen = await throughTunnel(running.socketPath, 'api.rules.test', {
      'x-api-key': PLACEHOLDER,
      authorization: 'Bearer own',
    })
    expect(seen).toMatchObject({ status: 200, apiKey: 'rule-key-123', authorization: 'Bearer own' })
    expect(await connectStatus(running, 'rules.test:443')).toBe(403)
    expect(await connectStatus(running, 'api.rules.test:8443')).toBe(403)
    await running.close()
  })

  it('retries a 401 once with a freshly minted token and the same body', async () => {
    const issued: string[] = []
    const minter = createTokenMinter({
      fetch: async () => {
        issued.push(issued.length === 0 ? 'stale-token' : 'fresh-token')
        const body = { access_token: issued.at(-1), expires_in: 3600 }
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
      },
      secret: async () => Promise.resolve('client-secret-value'),
      rotate: async () => Promise.resolve(false),
      record: async () => Promise.resolve(),
      now: () => Date.now(),
    })
    const header = { name: 'Authorization', template: 'Bearer {{value}}' }
    const rule = connectionRule(
      {
        id: 'minted-connection',
        name: 'minted',
        kind: 'client_credentials',
        env: 'MINTED',
        placeholder: 'seti-secret-minted',
        hosts: ['minted.rules.test'],
        header,
        mint: mintSettingsInput.parse({ token_url: 'https://login.rules.test/token', client_id: 'app' }),
        slots: { client_secret: 'named:app_secret' },
        mint_error: null,
        mint_checked_at: null,
        created_at: '',
        updated_at: '',
      },
      header,
      minter,
    )
    const running = await proxy(async () => Promise.resolve([]), both, [rule])
    const seen = await throughTunnel(running.socketPath, 'minted.rules.test', {}, '/strict')
    expect(seen).toMatchObject({ status: 200, authorization: 'Bearer fresh-token', body: 'hello' })
    expect(issued).toEqual(['stale-token', 'fresh-token'])
    const again = await throughTunnel(running.socketPath, 'minted.rules.test', {}, '/strict')
    expect(again).toMatchObject({ status: 200, authorization: 'Bearer fresh-token' })
    expect(issued).toHaveLength(2)
    await running.close()
  })

  it('passes a 401 through when the rule cannot renew', async () => {
    const rule: EgressRule = {
      hosts: ['static.rules.test'],
      port: 443,
      header: 'authorization',
      value: async () => Promise.resolve('Bearer stale-token'),
    }
    const running = await proxy(async () => Promise.resolve([]), both, [rule])
    const seen = await throughTunnel(running.socketPath, 'static.rules.test', {}, '/strict')
    expect(seen).toMatchObject({ status: 401, authorization: 'Bearer stale-token' })
    await running.close()
  })

  describe('API key placeholders', () => {
    const KEY = ['xi', 'real', 'Vb38'].join('-')
    const OTHER_KEY = ['other', 'real', 'Pz11'].join('-')
    const HOLDER = `seti-secret-voice_key-${'a1'.repeat(16)}`
    const OTHER_HOLDER = `seti-secret-other_key-${'b2'.repeat(16)}`
    const entries: EgressPlaceholder[] = [
      { name: 'voice_key', placeholder: HOLDER, hosts: ['keys.rules.test'], value: async () => Promise.resolve(KEY) },
      {
        name: 'other_key',
        placeholder: OTHER_HOLDER,
        hosts: ['other.rules.test'],
        value: async () => Promise.resolve(OTHER_KEY),
      },
    ]
    const blocked: { host: string; names: readonly string[] }[] = []
    const keyed = async () =>
      proxy(allowAll, both, [], {
        placeholders: () => entries,
        onBlocked: (host, names) => blocked.push({ host, names }),
      })

    it('swaps the key into headers, Basic credentials and the query on its own host', async () => {
      const running = await keyed()
      const basicOf = (key: string) => {
        const pair = Buffer.from(`api:${key}`).toString('base64')
        return `Basic ${pair}`
      }
      const basic = basicOf(HOLDER)
      const seen = await throughTunnel(
        running.socketPath,
        'keys.rules.test',
        { 'X-Api-Key': HOLDER, authorization: basic },
        `/v1/speech?key=${HOLDER}&voice=1`,
      )
      expect(seen).toMatchObject({
        status: 200,
        apiKey: KEY,
        authorization: basicOf(KEY),
        path: `/v1/speech?key=${KEY}&voice=1`,
      })
      await running.close()
    })

    it('refuses and reports a placeholder headed for another host, without sending it', async () => {
      const running = await keyed()
      blocked.length = 0
      const header = await rawThroughTunnel(running.socketPath, 'other.rules.test', { 'x-api-key': HOLDER }, '/')
      expect(header.status).toBe(403)
      expect(header.body).toContain('voice_key')
      expect(header.body).not.toContain(KEY)
      const query = await rawThroughTunnel(running.socketPath, 'other.rules.test', {}, `/?q=${HOLDER}`)
      expect(query.status).toBe(403)
      const claude = await viaSocket(running.socketPath, { method: 'POST', path: `/v1/messages?k=${HOLDER}` }, '{}')
      expect(claude.status).toBe(403)
      const plain = await viaSocket(running.socketPath, {
        path: `http://plain.test/?key=${HOLDER}`,
        headers: { host: 'plain.test' },
      })
      expect(plain.status).toBe(403)
      expect(blocked).toEqual([
        { host: 'other.rules.test', names: ['voice_key'] },
        { host: 'other.rules.test', names: ['voice_key'] },
        { host: ANTHROPIC_HOST, names: ['voice_key'] },
        { host: 'plain.test', names: ['voice_key'] },
      ])
      const own = await throughTunnel(running.socketPath, 'other.rules.test', { 'x-api-key': OTHER_HOLDER })
      expect(own).toMatchObject({ status: 200, apiKey: OTHER_KEY })
      await running.close()
    })

    it('swaps keys into WebSocket handshakes on their host and refuses them elsewhere', async () => {
      const running = await keyed()
      const ok = await upgradeThroughTunnel(
        running.socketPath,
        'keys.rules.test',
        { 'x-api-key': HOLDER },
        `/v1/stream?key=${HOLDER}`,
      )
      expect(ok.status).toBe(101)
      expect(ok.headers['x-seen-key']).toBe(KEY)
      expect(ok.headers['x-seen-path']).toBe(`/v1/stream?key=${KEY}`)
      const refusedUpgrade = await upgradeThroughTunnel(running.socketPath, 'other.rules.test', {}, `/?k=${HOLDER}`)
      expect(refusedUpgrade.status).toBe(403)
      expect(refusedUpgrade.body).not.toContain(KEY)
      await running.close()
    })

    it('matches hosts exactly, so look-alike suffixes and plain HTTP never get the key', async () => {
      const eleven: EgressPlaceholder = {
        name: 'eleven',
        placeholder: HOLDER,
        hosts: ['api.elevenlabs.io', '*.elevenlabs.io'],
        value: async () => Promise.resolve(KEY),
      }
      const headers = { 'xi-api-key': HOLDER }
      for (const host of [
        'api.elevenlabs.io.evil.com',
        'evil-api.elevenlabs.io.attacker.com',
        'elevenlabs.io.attacker.com',
        'notelevenlabs.io',
      ]) {
        expect(await swapPlaceholders({ host, port: 443 }, '/', headers, [eleven])).toEqual({
          kind: 'blocked',
          names: ['eleven'],
        })
      }
      expect(await swapPlaceholders({ host: 'api.elevenlabs.io', port: 80 }, '/', headers, [eleven])).toMatchObject({
        kind: 'blocked',
      })
      expect(await swapPlaceholders({ host: 'eu.elevenlabs.io', port: 443 }, '/', headers, [eleven])).toMatchObject({
        kind: 'ok',
        headers: { 'xi-api-key': KEY },
      })
    })
  })

  describe('AWS', () => {
    const AWS_TOKEN = ['aws', 'container', 'fake'].join('-')
    const fake: ContainerCredentials = {
      AccessKeyId: 'ASIAFAKE',
      SecretAccessKey: ['fake', 'secret'].join('-'),
      Token: 'fake-session',
      Expiration: '2026-09-29T13:00:00.000Z',
    }
    let on = true
    let configured = true
    const aws: EgressAws = {
      enabled: async () => Promise.resolve(on),
      token: AWS_TOKEN,
      credentials: async () => Promise.resolve(configured ? fake : null),
    }
    const fetchCredentials = async (running: EgressProxy, authorization?: string) =>
      viaSocket(running.socketPath, {
        path: AWS_CREDENTIALS_PATH,
        headers: authorization === undefined ? {} : { authorization },
      })

    it('serves the role credentials only with the task token, while AWS is on and configured', async () => {
      const running = await proxy(allowAll, both, [], { aws })
      const served = await fetchCredentials(running, AWS_TOKEN)
      expect(served.status).toBe(200)
      expect(JSON.parse(served.body)).toEqual(fake)
      expect((await fetchCredentials(running)).status).toBe(401)
      const wrong = await fetchCredentials(running, 'guess')
      expect(wrong.status).toBe(401)
      expect(wrong.body).not.toContain(fake.SecretAccessKey)
      configured = false
      const unconfigured = await fetchCredentials(running, AWS_TOKEN)
      expect(unconfigured.status).toBe(503)
      expect(unconfigured.body).toContain('not configured')
      on = false
      expect((await fetchCredentials(running, AWS_TOKEN)).status).toBe(404)
      on = true
      configured = true
      await running.close()
      const withoutAws = await proxy(allowAll, both)
      expect((await fetchCredentials(withoutAws, AWS_TOKEN)).status).toBe(404)
      await withoutAws.close()
    })

    it('allows AWS endpoints only while the task has AWS on, and never the metadata service', async () => {
      const running = await proxy(async () => Promise.resolve([]), both, [], { aws })
      const status = async (authority: string) => connectStatus(running, authority)
      expect(await status('logs.us-east-1.amazonaws.com:443')).not.toBe(403)
      expect(await status('169.254.169.254:80')).toBe(403)
      expect(await status('logs.us-east-1.amazonaws.com:80')).toBe(403)
      on = false
      expect(await status('logs.us-east-1.amazonaws.com:443')).toBe(403)
      on = true
      await running.close()
    })
  })

  it("lets ssh reach only the first hops of Seti's ssh config, and only while the task has SSH on", async () => {
    let on = true
    const targets = ['bastion.tunnel.test:2222']
    const running = await startEgressProxy({
      socketPath: path.join(dir, 'ssh.sock'),
      allowed: async () => Promise.resolve([]),
      ca,
      credentials: both,
      ssh: async (authority) => Promise.resolve(on && targets.includes(authority)),
      upstream: { address: async () => Promise.resolve({ host: '127.0.0.1', port: echoPort }) },
    })
    expect(await connectStatus(running, 'bastion.tunnel.test:2222')).toBe(200)
    expect(await connectStatus(running, 'bastion.tunnel.test:22')).toBe(403)
    expect(await connectStatus(running, 'other.tunnel.test:2222')).toBe(403)
    on = false
    expect(await connectStatus(running, 'bastion.tunnel.test:2222')).toBe(403)
    await running.close()
  })

  it('refuses a malformed CONNECT target', async () => {
    const running = await proxy(allowAll, both)
    const { status, socket } = await connect(running.socketPath, 'no-port')
    expect(status).toBe(400)
    socket.destroy()
    await running.close()
  })
})
