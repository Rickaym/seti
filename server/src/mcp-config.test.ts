import { isRemovableScope, mcpServerInput, mcpServerRemoveQuery, type McpServerInput } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import type { HttpError } from './http.js'
import { addArgs, createMcpConfig, removeArgs, type RunCli } from './mcp-config.js'

await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  process.env.SETI_HOME = nodePath.join(mkdtempSync(nodePath.join(tmpdir(), 'seti-mcp-test-')), 'seti')
})

const REPO = '0b9f7c4e-3f1a-4d8e-9a55-2b8f3f0c1d2e'
const parse = (input: McpServerInput) => mcpServerInput.parse(input)

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (e) {
    return e as HttpError
  }
  throw new Error('expected a rejection')
}

describe('mcpServerInput', () => {
  it('fills defaults for headers, args and env', () => {
    expect(parse({ name: 'x', scope: 'user', transport: 'http', url: 'https://a.example.com/mcp' })).toMatchObject({
      headers: [],
    })
    expect(parse({ name: 'x', scope: 'user', transport: 'stdio', command: 'npx' })).toMatchObject({ args: [], env: [] })
  })

  it.each<[string, McpServerInput]>([
    ['a bad name', { name: 'bad name', scope: 'user', transport: 'http', url: 'https://a.example.com' }],
    ['a plugin name', { name: 'plugin:x:y', scope: 'user', transport: 'http', url: 'https://a.example.com' }],
    ['a non-http url', { name: 'x', scope: 'user', transport: 'sse', url: 'ftp://a.example.com' }],
    ['project scope without a repo', { name: 'x', scope: 'project', transport: 'stdio', command: 'npx' }],
    ['an empty command', { name: 'x', scope: 'local', transport: 'stdio', command: ' ' }],
    [
      'a header with a line break',
      {
        name: 'x',
        scope: 'user',
        transport: 'http',
        url: 'https://a.example.com',
        headers: [{ key: 'X-Key', value: 'a\r\nInjected: 1' }],
      },
    ],
    [
      'a bad header name',
      {
        name: 'x',
        scope: 'user',
        transport: 'http',
        url: 'https://a.example.com',
        headers: [{ key: 'X Key', value: 'v' }],
      },
    ],
    [
      'duplicate env names',
      {
        name: 'x',
        scope: 'user',
        transport: 'stdio',
        command: 'npx',
        env: [
          { key: 'A', value: '1' },
          { key: 'A', value: '2' },
        ],
      },
    ],
    [
      'a bad env name',
      { name: 'x', scope: 'user', transport: 'stdio', command: 'npx', env: [{ key: '1A', value: '1' }] },
    ],
  ])('rejects %s', (_label, input) => {
    expect(mcpServerInput.safeParse(input).success).toBe(false)
  })

  it('requires a repo to remove a project server', () => {
    expect(mcpServerRemoveQuery.safeParse({ scope: 'project' }).success).toBe(false)
    expect(mcpServerRemoveQuery.safeParse({ scope: 'project', repo_id: REPO }).success).toBe(true)
    expect(mcpServerRemoveQuery.safeParse({ scope: 'dynamic' }).success).toBe(false)
  })

  it('treats only config file scopes as removable', () => {
    expect(['user', 'local', 'project', 'dynamic', 'claudeai', null].map(isRemovableScope)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ])
  })
})

describe('CLI arguments', () => {
  it('puts http options before -- and the name and url after it', () => {
    const input = parse({
      name: 'langfuse',
      scope: 'user',
      transport: 'http',
      url: 'https://cloud.langfuse.com/api/public/mcp',
      headers: [{ key: 'Authorization', value: 'Basic -abc' }],
    })
    expect(addArgs(input)).toEqual([
      'mcp',
      'add',
      '--scope',
      'user',
      '--transport',
      'http',
      '-H',
      'Authorization: Basic -abc',
      '--',
      'langfuse',
      'https://cloud.langfuse.com/api/public/mcp',
    ])
  })

  it('passes stdio env as -e pairs and args after the command', () => {
    const input = parse({
      name: 'local-tool',
      scope: 'local',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'some-mcp', '--flag'],
      env: [{ key: 'API_KEY', value: 's3cret' }],
    })
    expect(addArgs(input)).toEqual([
      'mcp',
      'add',
      '--scope',
      'local',
      '-e',
      'API_KEY=s3cret',
      '--',
      'local-tool',
      'npx',
      '-y',
      'some-mcp',
      '--flag',
    ])
  })

  it('builds remove arguments', () => {
    expect(removeArgs('x', 'project')).toEqual(['mcp', 'remove', '--scope', 'project', '--', 'x'])
  })
})

describe('createMcpConfig', () => {
  const secret = 'Bearer TOPSECRET'
  const input = parse({
    name: 'x',
    scope: 'user',
    transport: 'http',
    url: 'https://a.example.com/mcp',
    headers: [{ key: 'Authorization', value: secret }],
  })

  it('runs the CLI in the given cwd and returns only name and scope', async () => {
    const run = vi.fn<RunCli>(async () => Promise.resolve())
    const result = await createMcpConfig(run).add(input, '/home/me')
    expect(run).toHaveBeenCalledWith(addArgs(input), '/home/me')
    expect(result).toEqual({ name: 'x', scope: 'user' })
    expect(JSON.stringify(result)).not.toContain('TOPSECRET')
  })

  it('reports CLI stderr as a 400 with secret values redacted', async () => {
    const failure = Object.assign(new Error('Command failed'), { stderr: `Bad header ${secret}\n`, code: 1 })
    const run = vi.fn<RunCli>(async () => Promise.reject(failure))
    const error = await rejection(createMcpConfig(run).add(input, '/home/me'))
    expect(error.status).toBe(400)
    expect(error.message).toBe('Bad header [redacted]')
  })

  it('explains a missing CLI', async () => {
    const run = vi.fn<RunCli>(async () =>
      Promise.reject(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })),
    )
    const error = await rejection(createMcpConfig(run).remove('x', 'user', '/home/me'))
    expect(error.status).toBe(500)
    expect(error.message).toContain('SETI_CLAUDE_BIN')
  })

  it('removes with the scope and returns the change', async () => {
    const run = vi.fn<RunCli>(async () => Promise.resolve())
    await expect(createMcpConfig(run).remove('x', 'local', '/repo')).resolves.toEqual({ name: 'x', scope: 'local' })
    expect(run).toHaveBeenCalledWith(removeArgs('x', 'local'), '/repo')
  })
})
