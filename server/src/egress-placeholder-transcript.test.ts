import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import tls from 'node:tls'
import { PROVIDERS } from '@seti/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { EgressPlaceholder } from './egress-placeholders.js'
import { startEgressProxy, type EgressProxy } from './egress-proxy.js'
import { loadSandboxCa, type SandboxCa } from './sandbox-ca.js'

const OPENAI = 'api.openai.com'
const GOOGLE = 'generativelanguage.googleapis.com'
const ANTHROPIC = 'api.anthropic.com'
const GITHUB = 'api.github.com'
const MODEL_VALUE = ['sk', 'fake', 'model'].join('-')
const GH_VALUE = ['ghp', 'fake', 'token'].join('-')
const MODEL_HOLDER = `seti-secret-openai-${'a1'.repeat(16)}`
const GH_HOLDER = `seti-secret-github-${'b2'.repeat(16)}`
const VALUES = [MODEL_VALUE, GH_VALUE]

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-ph-transcript-'))
let ca: SandboxCa
let caPem: string
let standIn: https.Server
let standInPort = 0
let proxies = 0
const got: { host: string; body: string; headers: http.IncomingHttpHeaders }[] = []
const blocked: { host: string; names: readonly string[] }[] = []

const key = (host: string, body: boolean): EgressPlaceholder => ({
  name: 'model_key',
  placeholder: MODEL_HOLDER,
  hosts: [host],
  body,
  value: async () => Promise.resolve(MODEL_VALUE),
})
const github = (body: boolean): EgressPlaceholder => ({
  name: 'github',
  placeholder: GH_HOLDER,
  hosts: [GITHUB],
  body,
  value: async () => Promise.resolve(GH_VALUE),
})

/** The model hosts each runtime's grant carries, from the provider registry. */
const MODEL_HOSTS = {
  claude: PROVIDERS.anthropic.hosts,
  codex: PROVIDERS.openai.hosts,
  gemini: PROVIDERS.google.hosts,
}

beforeAll(async () => {
  ca = await loadSandboxCa(path.join(dir, 'ca'))
  await ca.cover(['openai.com', 'anthropic.com', 'github.com', 'googleapis.com'])
  caPem = fs.readFileSync(path.join(ca.publicDir, 'ca.pem'), 'utf8')
  const contexts = new Map<string, tls.SecureContext>()
  for (const host of [OPENAI, ANTHROPIC, GITHUB, GOOGLE]) {
    contexts.set(host, await ca.contextFor(host))
  }
  standIn = https.createServer({
    SNICallback: (name, done) => {
      done(null, contexts.get(name))
    },
  })
  standIn.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      got.push({ host: req.headers.host ?? '', body: Buffer.concat(chunks).toString(), headers: req.headers })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise<void>((resolve) => standIn.listen(0, '127.0.0.1', resolve))
  standInPort = (standIn.address() as AddressInfo).port
})

afterAll(() => {
  standIn.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  got.length = 0
  blocked.length = 0
})

async function proxy(entries: readonly EgressPlaceholder[], modelHosts: readonly string[]): Promise<EgressProxy> {
  return startEgressProxy({
    socketPath: path.join(dir, `proxy-${String(++proxies)}.sock`),
    allowed: async () => Promise.resolve([]),
    ca,
    credentials: {
      claude: async () => Promise.resolve('claude-oauth-fake'),
      github: async () => Promise.resolve(null),
      connector: async () => Promise.resolve(null),
    },
    placeholders: () => entries,
    modelHosts: () => modelHosts,
    onBlocked: (host, names) => blocked.push({ host, names }),
    upstream: { address: async () => Promise.resolve({ host: '127.0.0.1', port: standInPort }), tls: { ca: caPem } },
  })
}

/** A model request whose conversation holds a tool result that printed the agent's env. */
const turn = (...printed: string[]) =>
  JSON.stringify({ model: 'm', input: [{ role: 'tool', content: `$ env\n${printed.join('\n')}\nPATH=/usr/bin` }] })

interface Sent {
  path?: string
  headers?: Record<string, string>
}

/** A POST through a CONNECT tunnel to `host`, as Codex and Gemini reach their providers. */
async function viaTunnel(running: EgressProxy, host: string, body: string, sent: Sent = {}) {
  const socket = await new Promise<Duplex>((resolve, reject) => {
    const req = http.request({ socketPath: running.socketPath, method: 'CONNECT', path: `${host}:443` })
    req.on('connect', (_res, tunnel) => {
      resolve(tunnel)
    })
    req.on('error', reject)
    req.end()
  })
  const secure = tls.connect({ socket, servername: host, ca: caPem })
  const options = { host, path: sent.path ?? '/v1/responses', createConnection: () => secure }
  return send(options, https, body, sent.headers)
}

/** A POST in origin form to the proxy's socket, as Claude Code sends through ANTHROPIC_BASE_URL. */
async function viaBaseUrl(running: EgressProxy, body: string) {
  return send({ socketPath: running.socketPath, path: '/v1/messages' }, http, body)
}

async function send(
  options: http.RequestOptions,
  client: typeof http | typeof https,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = client.request(
      { ...options, method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let text = ''
        res.on('data', (chunk: Buffer) => (text += chunk.toString()))
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: text })
        })
      },
    )
    req.on('error', (e) => {
      resolve({ status: 0, body: e.message })
    })
    req.end(body)
  })
}

const noValueIn = (text: string) => {
  for (const value of VALUES) {
    expect(text).not.toContain(value)
  }
}

describe('a placeholder printed into the conversation, then sent in model request bodies', () => {
  it.each([
    ['codex', OPENAI, { authorization: `Bearer ${MODEL_HOLDER}` }],
    ['gemini', GOOGLE, { 'x-goog-api-key': MODEL_HOLDER }],
  ] as const)(
    '%s keeps working with Body off or on, and no value reaches the model body',
    async (runtime, host, auth) => {
      for (const body of [false, true]) {
        got.length = 0
        const running = await proxy([key(host, body), github(body)], MODEL_HOSTS[runtime])
        const sent = turn(`MODEL_KEY=${MODEL_HOLDER}`, `GH_TOKEN=${GH_HOLDER}`)
        const answer = await viaTunnel(running, host, sent, { headers: auth })
        expect(answer.status).toBe(200)
        expect(got).toHaveLength(1)
        expect(got[0]?.body).toBe(sent)
        noValueIn(got[0]?.body ?? '')
        expect(JSON.stringify(got[0]?.headers)).toContain(MODEL_VALUE)
        await running.close()
      }
      expect(blocked).toEqual([])
    },
  )

  it('a connection the user added on a model host for another purpose never swaps into its bodies', async () => {
    const scripts = { ...key(OPENAI, true), name: 'openai_scripts' }
    const running = await proxy([scripts], MODEL_HOSTS.codex)
    const sent = JSON.stringify({ input: `key ${MODEL_HOLDER}` })
    expect((await viaTunnel(running, OPENAI, sent)).status).toBe(200)
    expect(got[0]?.body).toBe(sent)
    await running.close()
  })

  it("Claude's model calls stream unread and byte for byte, with a connection on an Anthropic host too", async () => {
    for (const entries of [[github(false)], [key(ANTHROPIC, false), github(true)]]) {
      got.length = 0
      const running = await proxy(entries, MODEL_HOSTS.claude)
      const sent = turn(`GH_TOKEN=${GH_HOLDER}`, `ANTHROPIC_KEY=${MODEL_HOLDER}`)
      expect((await viaBaseUrl(running, sent)).status).toBe(200)
      expect(got[0]?.body).toBe(sent)
      await running.close()
    }
    expect(blocked).toEqual([])
  })

  it("only the runtime's own model hosts count: another provider's host still has its body read", async () => {
    const running = await proxy([key(OPENAI, false)], MODEL_HOSTS.claude)
    const answer = await viaTunnel(running, OPENAI, turn(MODEL_HOLDER))
    expect(answer.status).toBe(403)
    expect(answer.body).toContain('goes in a header')
    expect(answer.body).not.toContain('turn on Body')
    expect(got).toEqual([])
    await running.close()
  })
})

describe('what stays as it was on a model host and elsewhere', () => {
  it('refuses a placeholder in a header or URL toward a host its connection does not allow', async () => {
    const running = await proxy([key(OPENAI, false), github(false)], MODEL_HOSTS.codex)
    const header = await viaTunnel(running, OPENAI, '{}', { headers: { 'x-extra': GH_HOLDER } })
    const url = await viaTunnel(running, OPENAI, '{}', { path: `/v1/responses?t=${GH_HOLDER}` })
    const out = await viaTunnel(running, GITHUB, '{}', { headers: { authorization: `Bearer ${MODEL_HOLDER}` } })
    for (const answer of [header, url, out]) {
      expect(answer.status).toBe(403)
      expect(answer.body).toContain('only to the hosts the user allowed')
      noValueIn(answer.body)
    }
    expect(got).toEqual([])
    expect(blocked).toEqual([
      { host: OPENAI, names: ['github'] },
      { host: OPENAI, names: ['github'] },
      { host: GITHUB, names: ['model_key'] },
    ])
    await running.close()
  })

  it('refuses placeholders in bodies on other hosts, without advising Body for a model key', async () => {
    const running = await proxy([key(OPENAI, false), github(false)], MODEL_HOSTS.codex)
    const own = await viaTunnel(running, GITHUB, JSON.stringify({ token: GH_HOLDER }))
    expect(own.status).toBe(403)
    expect(own.body).toContain('sent nothing')
    expect(own.body).toContain('ask the user to turn on Body for that connection')
    const other = await viaTunnel(running, GITHUB, JSON.stringify({ key: MODEL_HOLDER }))
    expect(other.status).toBe(403)
    expect(other.body).toContain('only to the hosts the user allowed')
    expect(other.body).not.toContain('Body')
    for (const answer of [own, other]) {
      expect(answer.body).not.toMatch(/sandbox off|turn the sandbox/i)
      noValueIn(answer.body)
    }
    expect(got).toEqual([])
    expect(blocked).toEqual([
      { host: GITHUB, names: ['github'] },
      { host: GITHUB, names: ['model_key'] },
    ])
    noValueIn(JSON.stringify(blocked))
    await running.close()
  })

  it('still swaps into bodies on a host that is not a model host when the user turned Body on', async () => {
    const running = await proxy([key(OPENAI, false), github(true)], MODEL_HOSTS.codex)
    const answer = await viaTunnel(running, GITHUB, JSON.stringify({ token: GH_HOLDER }))
    expect(answer.status).toBe(200)
    expect(got[0]?.body).toBe(JSON.stringify({ token: GH_VALUE }))
    await running.close()
  })
})
