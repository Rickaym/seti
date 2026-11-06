import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { connectTarget, loopbackHost } from './seal.js'

const SEAL = fileURLToPath(new URL('./seal.ts', import.meta.url))

/** Seals a fresh Node process, tries every way out and reports what happened, one line per try. */
const PROBE = `
import { createRequire } from 'node:module'
import { execFile, execFileSync, spawn, exec } from 'node:child_process'
import { promisify } from 'node:util'
import http from 'node:http'
import net from 'node:net'
import { sealDemoProcess } from ${JSON.stringify(SEAL)}

sealDemoProcess((program, args) => (program === 'gh' && args[0] === 'api' ? 'fake gh\\n' : null))
const require = createRequire(import.meta.url)
const out = {}
const tryIt = async (name, fn) => {
  try {
    out[name] = 'ran: ' + String(await fn())
  } catch (e) {
    out[name] = 'refused: ' + (e.cause?.message ?? e.message)
  }
}
await tryIt('spawn', () => new Promise((resolve, reject) => {
  const child = spawn('true')
  child.on('error', reject)
  child.on('exit', (code) => resolve('exit ' + code + ' pid ' + child.pid))
}))
await tryIt('exec', () => new Promise((resolve, reject) => exec('true', (e) => (e ? reject(e) : resolve('ok')))))
await tryIt('execFileSync', () => execFileSync('true'))
await tryIt('gh', async () => (await promisify(execFile)('gh', ['api', 'user'])).stdout.trim())
await tryIt('git', async () => (await promisify(execFile)('git', ['status'])).stdout)
await tryIt('pty', () => require('node-pty').spawn('bash', [], {}))
await tryIt('worker', () => new (require('node:worker_threads').Worker)('process.exit()', { eval: true }))
await tryIt('dgram', () => require('node:dgram').createSocket('udp4'))
await tryIt('fetch', async () => (await fetch('http://example.com/')).status)
await tryIt('connect', () => net.connect({ host: '10.1.2.3', port: 80 }))
const server = http.createServer((_req, res) => res.end('loopback ok')).listen(0, '127.0.0.1')
await new Promise((resolve) => server.once('listening', resolve))
await tryIt('loopback', async () => (await fetch('http://127.0.0.1:' + server.address().port + '/')).text())
server.close()
process.stdout.write(JSON.stringify(out))
`

describe('the sealed demo process', () => {
  it('starts no process, terminal or worker, reaches no network, and still answers the fakes', () => {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', PROBE], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      encoding: 'utf8',
      timeout: 60_000,
    })
    const results = JSON.parse(stdout) as Record<string, string>
    expect(results.spawn).toMatch(/^refused: The demo never runs true$/)
    expect(results.exec).toBe('refused: The demo never runs a shell')
    expect(results.execFileSync).toBe('refused: The demo never runs true')
    expect(results.gh).toBe('ran: fake gh')
    expect(results.git).toBe('refused: The demo never runs git')
    expect(results.pty).toBe('refused: The demo never opens a terminal')
    expect(results.worker).toBe('refused: The demo never starts a worker')
    expect(results.dgram).toBe('refused: The demo never reaches the network')
    expect(results.fetch).toBe('refused: The demo never reaches the network')
    expect(results.connect).toBe('refused: The demo never reaches the network')
    expect(results.loopback).toBe('ran: loopback ok')
  })
})

describe('connect targets', () => {
  it('reads every shape Socket#connect takes', () => {
    expect(connectTarget([{ host: 'a.example', port: 1 }])).toEqual({ host: 'a.example', port: 1 })
    expect(connectTarget([[{ path: '/run/pg.sock' }, null]])).toEqual({ path: '/run/pg.sock' })
    expect(connectTarget(['/run/pg.sock'])).toEqual({ path: '/run/pg.sock' })
    expect(connectTarget([5432, 'db.example'])).toEqual({ host: 'db.example' })
    expect(connectTarget(['5432'])).toEqual({ host: undefined })
  })

  it('counts only loopback names and addresses as loopback', () => {
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- loopback addresses are what this checks
    for (const host of [undefined, 'localhost', '127.0.0.1', '127.8.9.10', '::1', '[::1]', '::ffff:127.0.0.1']) {
      expect(loopbackHost(host), String(host)).toBe(true)
    }
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- addresses the demo must refuse
    for (const host of ['10.0.0.1', 'example.com', '0.0.0.0', '::', 'localhost.example.com', '169.254.169.254']) {
      expect(loopbackHost(host), host).toBe(false)
    }
  })
})
