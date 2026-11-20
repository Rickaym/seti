import { execFileSync } from 'node:child_process'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Task } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { findBinary } from './binaries.js'
import { SETI_HOME } from './config.js'
import { tasks } from './db.js'
import { ANTHROPIC_HOST } from './egress-hosts.js'
import { inProcessSandboxAccess, type SandboxAccess, type SandboxFact } from './sandbox-access.js'
import { sandboxContext } from './sandbox-context.js'
import { sshKeyService } from './ssh-key-service.js'
import { createSshHost } from './ssh.js'
import { taskAccess } from './store/access.js'
import { auditEvents } from './store/audit.js'
import type { ConnectionRow } from './store/connections.js'
import { sandboxPolicy } from './store/sandbox.js'
import { removeTaskSandbox, taskSandbox } from './task-sandbox.js'
import { keyConnection } from './test-connections.js'

createApp()

const KEY = ['plain', 'vendor', 'key', 'Rt52'].join('-')

const available = (() => {
  try {
    execFileSync(findBinary('bwrap'), ['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', 'true'])
    findBinary('socat')
    return true
  } catch {
    return false
  }
})()

async function newTask(id: string): Promise<Task> {
  await tasks.insert({ id, title: id, repo_id: null, cwd: '/tmp', worktree: false, sandbox: true, pr_urls: [] })
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('no task')
  }
  return task
}

const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

describe('the in-process sandbox access', () => {
  it('answers with plain data that survives a trip through JSON', async () => {
    const task = await newTask('access-plain')
    await keyConnection('plainvendor', KEY, {
      hosts: ['api.plain.test'],
      header: { name: 'X-Api-Key', template: '{{value}}' },
      profile_ids: [task.profile_id],
    })
    const key = await sshKeyService.generate('access plain')
    const user = os.userInfo().username
    await createSshHost('plainbox', { hostname: '127.0.0.1', port: 22, user, key_id: key.id, jump: null, options: [] })
    await taskAccess.set(task.id, 'ssh', 'plainbox', true)

    const access = inProcessSandboxAccess
    const setup = await access.setup(task)
    expect(setup.connections.map((row) => row.name)).toEqual(['plainvendor'])
    expect(setup.ssh?.hosts.map((host) => host.alias)).toEqual(['plainbox'])
    expect(setup.ssh?.publicKeys[key.id]).toBe(key.public_key)
    expect(JSON.stringify(setup)).not.toContain(KEY)
    const answers = {
      setup,
      allowed: await access.allowedHosts(task.id),
      firstHops: await access.sshFirstHops(task.id),
      aws: await access.awsEnabled(task.id),
      awsCredentials: await access.awsCredentials(task.profile_id),
      github: await access.githubToken(task.profile_id, null),
    }
    expect(roundTrip(answers)).toEqual(answers)
    expect(answers.firstHops).toEqual(['127.0.0.1:22'])
    const keys = await access.sshKeys(task.id)
    expect(roundTrip(keys)).toEqual(keys)
    expect(keys).toHaveLength(1)
    const [row] = setup.connections
    expect(row === undefined ? null : await access.connectionValue(roundTrip(row) as ConnectionRow)).toBe(KEY)
  })
})

const resolved = async <T>(value: T) => Promise.resolve(value)

/** A fake access that records what the proxy asks and reports, with one connection. */
function fakeAccess(connection: ConnectionRow) {
  const asked: string[] = []
  const reported: SandboxFact[] = []
  const access: SandboxAccess = {
    setup: async () =>
      resolved({
        deniedServers: [],
        deniedConnectors: [],
        connections: [connection],
        borrowedServers: {},
        login: null,
        github: false,
        connectors: false,
        aws: null,
        ssh: null,
      }),
    allowedHosts: async (taskId) => {
      asked.push(`allowed ${taskId}`)
      return resolved([])
    },
    sshFirstHops: async (taskId) => {
      asked.push(`ssh ${taskId}`)
      return resolved([])
    },
    sshKeys: async () => resolved([]),
    awsEnabled: async () => resolved(false),
    awsCredentials: async () => resolved(null),
    claudeToken: async () => resolved(null),
    githubToken: async () => resolved(null),
    connectorToken: async () => resolved(null),
    connectionValue: async () => resolved(KEY),
    renewConnection: async () => resolved(null),
    report: async (fact) => {
      reported.push(fact)
      return resolved(undefined)
    },
  }
  return { access, asked, reported }
}

const HOLDER = `seti-secret-faked-${'c3'.repeat(16)}`

const connection: ConnectionRow = {
  id: 'faked-connection',
  name: 'faked',
  kind: 'key',
  env: 'FAKED_KEY',
  placeholder: HOLDER,
  hosts: ['keys.faked.test'],
  header: null,
  mint: null,
  slots: {},
  mint_error: null,
  mint_checked_at: null,
  created_at: '',
  updated_at: '',
}

async function viaSocket(socketPath: string, method: string, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: target, headers: { host: 'faked.test' } }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

describe.skipIf(!available)('a sandbox proxy built with a fake access', () => {
  it('asks the access for the allowlist and reports refusals and blocked keys to it', async () => {
    const task = await newTask('access-fake')
    const fake = fakeAccess(connection)
    const policy = await sandboxPolicy.get()
    try {
      await taskSandbox(task, { ctx: sandboxContext(), policy, access: fake.access })
      const socket = path.join(SETI_HOME, 'sandbox', task.id, 'run', 'proxy.sock')
      expect(await viaSocket(socket, 'GET', 'http://refused.faked.test/')).toBe(403)
      expect(await viaSocket(socket, 'POST', `/v1/messages?k=${HOLDER}`)).toBe(403)
      expect(fake.asked).toContain(`allowed ${task.id}`)
      expect(fake.reported).toEqual([
        { kind: 'host_refused', taskId: task.id, host: 'refused.faked.test' },
        { kind: 'key_blocked', task: { id: task.id, title: task.title }, host: ANTHROPIC_HOST, names: ['faked'] },
      ])
      expect(JSON.stringify(fake.reported)).not.toContain(KEY)
      expect(await auditEvents.latest('task.api_key_blocked')).toBeUndefined()
    } finally {
      await removeTaskSandbox(task.id)
    }
  })
})
