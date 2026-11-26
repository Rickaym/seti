import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Task } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { findBinary } from './binaries.js'
import { tasks } from './db.js'
import { sandboxPlanFor } from './launch-plan.js'
import './runner.js'
import { loadSandboxCa } from './sandbox-ca.js'
import { askSecret, supplySecret } from './secret-questions.js'
import { sandboxContext } from './session-options.js'
import { questions } from './store/questions.js'
import { sandboxPolicy } from './store/sandbox.js'
import { routeEgressForTests } from './task-proxy.js'
import { removeTaskSandbox, sandboxTmpDir, taskSandbox } from './task-sandbox.js'
import { clearConnections } from './test-connections.js'

const GRANTED = 'api.example.com'
const OTHER = 'other.example.com'

const available = (() => {
  try {
    findBinary('socat')
    execFileSync(findBinary('bwrap'), ['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', 'true'])
    return true
  } catch {
    return false
  }
})()

/**
 * A command the agent's runtime started before the secret, which waits for `/tmp/go` and then
 * starts fresh bash commands, as each Bash tool call does, against the granted and another host.
 */
const RUNTIME = [
  'echo "before=${LIVE_KEY:-unset}"',
  'while [ ! -e /tmp/go ]; do sleep 0.05; done',
  `bash -c 'echo "after=\${LIVE_KEY:-unset}"'`,
  `bash -c 'curl -sS -m 10 -H "Authorization: Bearer $LIVE_KEY" https://${GRANTED}/; echo'`,
  `bash -c 'curl -sS -m 10 -H "Authorization: Bearer $LIVE_KEY" https://${OTHER}/ >/dev/null 2>&1 || echo other-refused'`,
  'echo "file=$(stat -c %a /run/seti/env.sh)"',
].join('\n')

describe.skipIf(!available)('a secret supplied while a sandboxed agent runs', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seti-live-conn-')))
  const seen: string[] = []
  let server: https.Server
  let task: Task

  beforeAll(async () => {
    const ca = await loadSandboxCa(path.join(root, 'upstream-ca'))
    await ca.cover([GRANTED])
    const context = await ca.contextFor(GRANTED)
    const sni = (_name: string, done: (error: Error | null, ctx: typeof context) => void) => {
      done(null, context)
    }
    server = https.createServer({ SNICallback: sni }, (req, res) => {
      seen.push(req.headers.authorization ?? 'none')
      res.end('granted-answered')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    routeEgressForTests({
      upstream: {
        address: async (host) =>
          host === GRANTED ? Promise.resolve({ host: '127.0.0.1', port }) : Promise.reject(new Error(host)),
        tls: { ca: fs.readFileSync(path.join(ca.publicDir, 'ca.pem'), 'utf8') },
      },
      refused: () => undefined,
    })
    const id = `live-conn-${randomUUID()}`
    const work = path.join(root, 'work')
    fs.mkdirSync(work)
    await tasks.insert({ id, title: id, repo_id: null, cwd: work, worktree: false, pr_urls: [] })
    const stored = await tasks.get(id)
    if (stored === undefined) {
      throw new Error('Task was not stored')
    }
    task = stored
  })

  afterAll(async () => {
    routeEgressForTests(null)
    server.close()
    await removeTaskSandbox(task.id)
    await clearConnections()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('reaches the next bash command and the proxy in the same turn, on the granted host only', async () => {
    const plan = await sandboxPlanFor(task, await sandboxPolicy.get())
    const sandbox = await taskSandbox(task, { ctx: sandboxContext(), plan })
    const child = sandbox.spawn('/bin/bash', ['-c', RUNTIME], { stdin: 'ignore' })
    let out = ''
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (out += chunk.toString()))
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve))
    await vi.waitFor(() => {
      expect(out).toContain('before=unset')
    })

    const asked = askSecret(task, { name: 'LIVE_KEY', purpose: 'For the live test', hosts: [GRANTED] })
    const question = await vi.waitFor(async () => {
      const [open] = (await questions.forTask(task.id)).filter((each) => each.status === 'open')
      if (open === undefined) {
        throw new Error('no question yet')
      }
      return open
    })
    const value = ['fixture', 'value', randomUUID()].join('-')
    await supplySecret(question.id, value)
    const text = await asked
    expect(text).toContain('Your bash commands have $LIVE_KEY from now on, so carry on with your work in this turn')
    expect(text).toContain('`. /run/seti/env.sh`')
    expect(text).not.toContain(value)

    fs.writeFileSync(path.join(sandboxTmpDir(task.id), 'go'), '')
    expect(await exited).toBe(0)
    const lines = out.trim().split('\n')
    expect(lines[1]).toMatch(/^after=seti-secret-live_key-[0-9a-f]{32}$/)
    expect(lines.slice(2)).toEqual(['granted-answered', 'other-refused', 'file=600'])
    expect(seen).toEqual([`Bearer ${value}`])
    expect(out).not.toContain(value)
  }, 60_000)
})
