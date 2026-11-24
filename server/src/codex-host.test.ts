import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Task, ToolCall } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { codexHost } from './codex-host.js'
import { serveNode, type ControlEnd } from './node-link.js'
import { sandboxDirOf } from './owned-dirs.js'

await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  process.env.SETI_HOME = nodePath.join(mkdtempSync(nodePath.join(tmpdir(), 'seti-codex-host-test-')), 'seti')
})

const task = { id: 'codex-host-agent' } as Task
const none = async () => Promise.reject(new Error('not asked'))
const called: unknown[] = []
const decided: unknown[] = []

const answers = {
  'tools.list': async () =>
    Promise.resolve({ servers: [{ name: 'seti', tools: [{ name: 'list_agents', inputSchema: { type: 'object' } }] }] }),
  'tool.call': async (_taskId: string, call: unknown) => {
    called.push(call)
    return Promise.resolve({ result: { content: [{ type: 'text', text: 'two agents' }] } })
  },
  'call.decide': async (_taskId: string, ask: { call: unknown }) => {
    decided.push(ask.call)
    return Promise.resolve({ allow: false as const, message: 'Not in here.' })
  },
}
serveNode({
  journal: async () => Promise.resolve(),
  answer: new Proxy(answers, { get: (target, key) => (key in target ? target[key as keyof typeof target] : none) }),
} as unknown as ControlEnd)

describe("the node's host for a Codex agent", () => {
  it("serves Seti's tools through the relay in the sandbox's run folder, run on the control plane", async () => {
    const session = new AbortController()
    const host = await codexHost(task, session.signal)
    expect(host.toolServers.seti?.args).toEqual(['STDIO', 'UNIX-CONNECT:/run/seti/tools-0.sock'])
    const socket = path.join(sandboxDirOf(task.id), 'run', 'tools-0.sock')
    const command = host.toolServers.seti?.command ?? ''
    const client = new Client({ name: 'codex', version: '1' })
    await client.connect(new StdioClientTransport({ command, args: ['STDIO', `UNIX-CONNECT:${socket}`] }))
    const result = await client.callTool({ name: 'list_agents', arguments: {} })
    expect(result.content).toEqual([{ type: 'text', text: 'two agents' }])
    expect(called).toEqual([{ server: 'seti', tool: 'list_agents', args: {} }])
    await client.close()
    session.abort()
  })

  it("asks the control plane for Seti's answer to each call", async () => {
    const host = await codexHost(task, new AbortController().signal)
    const call: ToolCall = { callId: 'c1', kind: 'shell', name: 'exec_command', input: {}, shell: { action: 'run' } }
    expect(await host.decide(call, new AbortController().signal)).toEqual({ allow: false, message: 'Not in here.' })
    expect(decided).toEqual([call])
  })
})
