import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { paths } from './env.js'
import { test } from './fixtures.js'
import { FAKE_CLAUDE_ENV } from './processes.js'

/** The host the kitchen-sink mod reaches; .test names only resolve to a test run's fake upstream. */
const SINK_HOST = 'api.sink.test'

/** A throwaway certificate for the sink host, trusted by the server through NODE_EXTRA_CA_CERTS. */
function certificate(): { key: string; cert: string; certFile: string } {
  const dir = path.join(paths.root, 'sink-upstream')
  const keyFile = path.join(dir, 'key.pem')
  const certFile = path.join(dir, 'cert.pem')
  if (!fs.existsSync(certFile)) {
    fs.mkdirSync(dir, { recursive: true })
    execFileSync(
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- uses the openssl on the runner PATH
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        `/CN=${SINK_HOST}`,
        '-addext',
        `subjectAltName=DNS:${SINK_HOST}`,
        '-addext',
        'basicConstraints=critical,CA:TRUE',
        '-keyout',
        keyFile,
        '-out',
        certFile,
      ],
      { stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, OPENSSL_CONF: '/dev/null' }, cwd: dir },
    )
  }
  return { key: fs.readFileSync(keyFile, 'utf8'), cert: fs.readFileSync(certFile, 'utf8'), certFile }
}

/** One request the fake upstream took, as the mod's fetch sent it. */
interface SinkRequest {
  method: string
  path: string
  headers: Record<string, string>
  body: string
}

export interface SinkUpstream {
  /** What the server needs to send the mod's requests here. */
  env: NodeJS.ProcessEnv
  seen: SinkRequest[]
  close: () => Promise<void>
}

/** Answers the kitchen-sink mod's summarize call, echoing the Authorization header back. */
function answer(request: SinkRequest): { status: number; body: unknown } {
  if (request.method === 'POST' && request.path === '/v1/summarize') {
    return { status: 200, body: { summary: 'All quiet', echo: request.headers.authorization ?? null } }
  }
  return { status: 404, body: { error: 'not found' } }
}

/** A fake HTTPS upstream for the sink host, on a port of its own. */
async function startSinkUpstream(): Promise<SinkUpstream> {
  const { key, cert, certFile } = certificate()
  const seen: SinkRequest[] = []
  const server = https.createServer({ key, cert }, (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([name, value]) => [
          name,
          Array.isArray(value) ? value.join(', ') : (value ?? ''),
        ]),
      )
      const request = { method: req.method ?? '', path: req.url ?? '', headers, body: Buffer.concat(chunks).toString() }
      seen.push(request)
      const { status, body } = answer(request)
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    env: { SETI_MOD_TEST_UPSTREAM: String(port), NODE_EXTRA_CA_CERTS: certFile },
    seen,
    close: async () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      }),
  }
}

/** The suite's test with a fake sink upstream for the worker's server, and the fake Claude. */
export const sinkTest = test.extend<object, { sink: SinkUpstream }>({
  sink: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixtures name their dependencies, and this has none
    async ({}, use) => {
      const sink = await startSinkUpstream()
      await use(sink)
      await sink.close()
    },
    { scope: 'worker' },
  ],
  serverEnv: [
    async ({ sink }, use) => {
      await use({ ...FAKE_CLAUDE_ENV, ...sink.env })
    },
    { scope: 'worker' },
  ],
})
