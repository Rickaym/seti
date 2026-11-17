import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SharedToolManifest } from '@seti/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { TOOL_SERVER } from './shared-tools.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-tool-server-'))

const INPUT: SharedToolManifest['input'] = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'The text to count.' },
    unit: { type: 'string', enum: ['words', 'letters'] },
    limits: { type: 'array', items: { type: 'integer' } },
  },
  required: ['text'],
}

function toolDir(name: string, content: string, patch: Partial<SharedToolManifest> = {}): string {
  const dir = path.join(root, name)
  fs.mkdirSync(dir)
  const manifest: SharedToolManifest = {
    name,
    description: `The ${name} tool, for the server's own tests.`,
    input: INPUT,
    writes: false,
    timeout_seconds: 20,
    needs: [],
    file: 'tool.sh',
    run: ['/bin/sh'],
    ...patch,
  }
  fs.writeFileSync(path.join(dir, 'tool.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(dir, 'tool.sh'), content)
  return dir
}

const dirs = [
  toolDir('count', 'printf \'{"got": %s}\' "$(cat)"\n'),
  toolDir('plain', 'cat > /dev/null; echo "just text"\n', { writes: true }),
  toolDir('broken', 'cat > /dev/null; echo "partial"; echo "the upstream said no" >&2; exit 3\n'),
  toolDir('slow', 'sleep 30 & wait\n', { timeout_seconds: 1 }),
]

interface Reply {
  id: number
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

/** Sends the requests to one server process and returns its replies by request id. */
async function ask(requests: { method: string; params?: unknown }[]): Promise<Map<number, Reply>> {
  const child = spawn(process.execPath, [TOOL_SERVER, ...dirs], { stdio: ['pipe', 'pipe', 'inherit'] })
  let out = ''
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
  const lines = requests.map((request, index) => JSON.stringify({ jsonrpc: '2.0', id: index + 1, ...request }))
  child.stdin.end(`${lines.join('\n')}\n`)
  await new Promise((resolve) => child.on('exit', resolve))
  const replies = out
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Reply)
  return new Map(replies.map((reply) => [reply.id, reply]))
}

const callOf = (name: string, args: unknown) => ({ method: 'tools/call', params: { name, arguments: args } })

const textOf = (reply: Reply | undefined) => (reply?.result?.content as { text: string }[] | undefined)?.[0]?.text ?? ''

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the shared tool server', () => {
  it('answers initialize and lists each tool with its schema and what it declared', async () => {
    const replies = await ask([
      { method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {} } },
      { method: 'notifications/initialized' },
      { method: 'tools/list' },
      { method: 'resources/list' },
    ])
    expect(replies.get(1)?.result).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: {} } })
    const tools = replies.get(3)?.result?.tools as { name: string }[]
    expect(tools.map((tool) => tool.name)).toEqual(['count', 'plain', 'broken', 'slow'])
    expect(tools[0]).toMatchObject({
      description: "The count tool, for the server's own tests.",
      inputSchema: INPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    })
    expect(tools[1]).toMatchObject({ annotations: { readOnlyHint: false, openWorldHint: true } })
    expect(replies.get(4)?.error).toMatchObject({ code: -32601 })
  })

  it('passes the arguments on stdin and returns stdout, structured when it is a JSON object', async () => {
    const args = { text: 'one two', unit: 'words', limits: [1, 2] }
    const replies = await ask([callOf('count', args), callOf('plain', { text: 'x' })])
    expect(replies.get(1)?.result).toMatchObject({ isError: false, structuredContent: { got: args } })
    expect(replies.get(2)?.result).toEqual({ content: [{ type: 'text', text: 'just text\n' }], isError: false })
  })

  it('reports a failing script with its stderr, and stops one that runs past its time', async () => {
    const started = Date.now()
    const replies = await ask([callOf('broken', { text: 'x' }), callOf('slow', { text: 'x' })])
    expect(replies.get(1)?.result).toMatchObject({ isError: true })
    expect(textOf(replies.get(1))).toContain('exit 3')
    expect(textOf(replies.get(1))).toContain('the upstream said no')
    expect(replies.get(2)?.result).toMatchObject({ isError: true })
    expect(textOf(replies.get(2))).toContain('stopped after 1 seconds')
    expect(Date.now() - started).toBeLessThan(15_000)
  })

  it.each([
    [{}, 'text is required'],
    [{ text: 5 }, 'text must be a string'],
    [{ text: 'a', extra: true }, 'extra is not an argument'],
    [{ text: 'a', unit: 'pages' }, 'unit must be one of words, letters'],
    [{ text: 'a', limits: [1, 'two'] }, 'limits[1] must be an integer'],
  ])('refuses the arguments %j before it runs anything', async (args, problem) => {
    const reply = (await ask([callOf('count', args)])).get(1)
    expect(reply?.result).toMatchObject({ isError: true })
    expect(textOf(reply)).toBe(`Bad arguments: ${problem}`)
  })

  it('refuses a tool it was not given', async () => {
    const reply = (await ask([callOf('other', {})])).get(1)
    expect(textOf(reply)).toBe('No shared tool is named other')
  })
})
