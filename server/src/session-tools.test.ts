import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { tasks } from './db.js'
import { sessionHost } from './runtime-host.js'
import './session-ingest.js'
import { registerSessionMcpServers } from './session-tools.js'

const TASK = 'session-tools-task'

registerSessionMcpServers((task) => ({
  probe: [
    {
      name: 'echo',
      description: 'Says the text back, with the agent it ran as',
      input: { text: z.string().describe('What to say'), times: z.int().min(1).default(1) },
      call: async (args) => {
        const { text, times } = z.object({ text: z.string(), times: z.int() }).parse(args)
        return Promise.resolve({ content: [{ type: 'text', text: `${task.id}: ${text.repeat(times)}` }] })
      },
    },
  ],
}))

async function clientOf(config: unknown): Promise<Client> {
  const { instance } = config as McpSdkServerConfigWithInstance
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
  await instance.connect(serverEnd)
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(clientEnd)
  return client
}

describe('tools Seti serves a session', () => {
  it('lists them in the node as the control plane serves them, and runs each call as the agent', async () => {
    await tasks.insert({ id: TASK, title: 'Tools', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
    const task = await tasks.get(TASK)
    if (task === undefined) {
      throw new Error('task missing')
    }
    const host = await sessionHost(task, false, new AbortController().signal)
    const client = await clientOf(host.toolServers.probe)
    const { tools } = await client.listTools()
    expect(tools.map((entry) => entry.name)).toEqual(['echo'])
    expect(tools[0]?.inputSchema).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string', description: 'What to say' } },
      required: ['text'],
    })
    expect(await client.callTool({ name: 'echo', arguments: { text: 'hi', times: 2 } })).toMatchObject({
      content: [{ type: 'text', text: `${TASK}: hihi` }],
    })
    expect(await client.callTool({ name: 'echo', arguments: { times: 2 } })).toMatchObject({ isError: true })
    await client.close()
  })
})
