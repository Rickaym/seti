import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, describe, expect, it } from 'vitest'
import { openToolRelay, type RelayedServer, type StdioServer } from './tool-relay.js'

const dir = fs.mkdtempSync(path.join(tmpdir(), 'seti-tool-relay-'))
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const calls: { tool: string; args: Record<string, unknown> }[] = []
const seti: RelayedServer = {
  name: 'seti',
  tools: [{ name: 'list_agents', description: 'Lists agents', inputSchema: { type: 'object' } }],
  call: async (tool, args) => {
    calls.push({ tool, args })
    return Promise.resolve({ content: [{ type: 'text', text: `ran ${tool}` }] })
  },
}

/** Connects as the runtime does: it starts the relay's program and speaks MCP over its stdio. */
async function connect(server: StdioServer | undefined): Promise<Client> {
  if (server === undefined) {
    throw new Error('no server')
  }
  const client = new Client({ name: 'runtime', version: '1.0.0' })
  await client.connect(new StdioClientTransport({ command: server.command, args: server.args }))
  return client
}

describe("the relay for an agent's tool servers", () => {
  it('serves the listed tools over a socket only its owner opens, and runs each call', async () => {
    const control = new AbortController()
    const servers = await openToolRelay({ dir, seenAs: dir }, [seti], control.signal)
    expect(Object.keys(servers)).toEqual(['seti'])
    expect(servers.seti?.args).toEqual(['STDIO', `UNIX-CONNECT:${path.join(dir, 'tools-0.sock')}`])
    expect(fs.statSync(path.join(dir, 'tools-0.sock')).mode & 0o777).toBe(0o600)
    const client = await connect(servers.seti)
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['list_agents'])
    const result = await client.callTool({ name: 'list_agents', arguments: { all: true } })
    expect(result.content).toEqual([{ type: 'text', text: 'ran list_agents' }])
    expect(calls).toEqual([{ tool: 'list_agents', args: { all: true } }])
    await client.close()
    control.abort()
    await expect.poll(() => fs.existsSync(path.join(dir, 'tools-0.sock'))).toBe(false)
  })

  it('names the socket where the sandbox mounts the run folder', async () => {
    const control = new AbortController()
    const servers = await openToolRelay({ dir, seenAs: '/run/seti' }, [seti], control.signal)
    expect(servers.seti?.args).toEqual(['STDIO', 'UNIX-CONNECT:/run/seti/tools-0.sock'])
    control.abort()
  })

  it('serves nothing without servers or once the session ended', async () => {
    const ended = new AbortController()
    ended.abort()
    expect(await openToolRelay({ dir, seenAs: dir }, [], new AbortController().signal)).toEqual({})
    expect(await openToolRelay({ dir, seenAs: dir }, [seti], ended.signal)).toEqual({})
  })
})
