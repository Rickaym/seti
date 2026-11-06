import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import http2 from 'node:http2'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { paths } from './env.js'

/** Headers HTTP/2 forbids, which the plain HTTP/1.1 upstream sends. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade'])

/** A throwaway self-signed certificate for 127.0.0.1, made once per worker. */
function certificate(): { key: Buffer; cert: Buffer } {
  const dir = path.join(paths.root, 'h2-proxy')
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
        '/CN=127.0.0.1',
        '-keyout',
        keyFile,
        '-out',
        certFile,
      ],
      { stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, OPENSSL_CONF: '/dev/null' }, cwd: dir },
    )
  }
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }
}

interface H2Proxy {
  origin: string
  close: () => Promise<void>
}

/** Serves `upstream` over HTTP/2 and TLS, as the tunnel in front of a live Seti does. */
export async function startH2Proxy(upstream: string): Promise<H2Proxy> {
  const target = new URL(upstream)
  const server = http2.createSecureServer({ ...certificate(), allowHTTP1: false })
  server.on('stream', (stream, headers) => {
    const outgoing: http.OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(headers)) {
      if (!name.startsWith(':') && value !== undefined) {
        outgoing[name] = value
      }
    }
    outgoing.host = target.host
    if (outgoing.origin !== undefined) {
      outgoing.origin = target.origin
    }
    const request = http.request({
      host: target.hostname,
      port: target.port,
      method: String(headers[':method']),
      path: String(headers[':path']),
      headers: outgoing,
    })
    request.on('response', (response) => {
      const back: http2.OutgoingHttpHeaders = { ':status': response.statusCode ?? 502 }
      for (const [name, value] of Object.entries(response.headers)) {
        if (!HOP_BY_HOP.has(name) && value !== undefined) {
          back[name] = value
        }
      }
      if (stream.destroyed) {
        response.destroy()
        return
      }
      stream.respond(back)
      response.pipe(stream)
    })
    request.on('error', () => {
      if (!stream.destroyed && !stream.headersSent) {
        stream.respond({ ':status': 502 })
      }
      stream.end()
    })
    stream.on('close', () => {
      request.destroy()
    })
    stream.pipe(request)
  })
  const sessions = new Set<http2.ServerHttp2Session>()
  server.on('session', (session) => {
    sessions.add(session)
    session.on('close', () => sessions.delete(session))
  })
  server.on('sessionError', () => undefined)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  return {
    origin: `https://127.0.0.1:${String(port)}`,
    close: async () =>
      new Promise<void>((resolve) => {
        for (const session of sessions) {
          session.destroy()
        }
        server.close(() => {
          resolve()
        })
      }),
  }
}
