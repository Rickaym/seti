import { randomUUID } from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import { proxyGrant, type GrantConnection } from '@seti/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { tasks } from './db.js'
import './session-ingest.js'
import { auditEvents } from './store/audit.js'
import { closeTaskProxy, maintenanceDirOf, openModelProxy } from './task-proxy.js'

const HOLDER = `seti-secret-openai-${'e5'.repeat(16)}`

const key: GrantConnection = {
  id: 'openai-key',
  name: 'openai',
  env: 'OPENAI_API_KEY',
  placeholder: HOLDER,
  hosts: ['api.openai.com'],
  header: { name: 'authorization', template: 'Bearer {{value}}' },
  minted: false,
  body: false,
}

/** A model call in origin form to the maintenance proxy, which sends it to Anthropic. */
async function post(socketPath: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request({ socketPath, path: '/v1/messages', method: 'POST', headers }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', () => {
      resolve(0)
    })
    req.end('{}')
  })
}

describe("a maintenance sandbox's proxy", () => {
  const id = `mp-${randomUUID().slice(0, 8)}`

  afterAll(async () => {
    await closeTaskProxy(id)
  })

  it('audits a request it refuses for carrying the key toward another host, naming no value', async () => {
    await tasks.insert({ id, title: id, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
    await openModelProxy(id, { login: null, key, modelHosts: ['api.openai.com'] })
    const socket = path.join(maintenanceDirOf(id), 'run', 'proxy.sock')
    expect(await post(socket, { authorization: `Bearer ${HOLDER}` })).toBe(403)
    await expect.poll(async () => (await auditEvents.latest('task.api_key_blocked'))?.subject_id).toBe(id)
    const entry = await auditEvents.latest('task.api_key_blocked')
    expect(entry).toMatchObject({ detail: { host: 'api.anthropic.com', keys: ['openai'] } })
  })
})

describe('model hosts in a grant', () => {
  const base = { login: null, connections: [], mcp: [], deniedConnectors: [], caHosts: [] }

  it("take only a provider's own hosts, so nothing else can count as one", () => {
    expect(proxyGrant.parse({ ...base, modelHosts: ['generativelanguage.googleapis.com'] }).modelHosts).toEqual([
      'generativelanguage.googleapis.com',
    ])
    for (const host of ['api.github.com', '*.openai.com', 'API.OPENAI.COM', 'openai.com']) {
      expect(proxyGrant.safeParse({ ...base, modelHosts: [host] }).success).toBe(false)
    }
  })

  it('default to none, so a grant without them reads every body as before', () => {
    expect(proxyGrant.parse(base).modelHosts).toEqual([])
  })
})
