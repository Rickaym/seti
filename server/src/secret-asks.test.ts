import { describe, expect, it } from 'vitest'
import { tasks } from './db.js'
import { nodeLink } from './node-link.js'
import './runner.js'

describe("the credentials a node's egress proxy asks the control plane for", () => {
  it('answers with what the agent may use, and none where it has none', async () => {
    const id = 'secret-asks-1'
    await tasks.insert({ id, title: 'Secrets', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
    expect(await nodeLink.ask(id, 'secret.mint', { kind: 'github', owner: null })).toEqual({ token: null })
    expect(await nodeLink.ask(id, 'aws.credentials', {})).toEqual({ credentials: null })
    expect(await nodeLink.ask(id, 'ssh.keys', {})).toEqual({ keys: [] })
    expect(await nodeLink.ask(id, 'connection.value', { connection: 'none', refused: null })).toEqual({ value: null })
    expect(await nodeLink.ask(id, 'secret.mint', { kind: 'mcp', url: 'https://mcp.none.test/mcp' })).toEqual({
      token: null,
    })
    await expect(nodeLink.ask('missing-agent', 'aws.credentials', {})).rejects.toThrow(
      'The control plane could not answer aws.credentials',
    )
  })
})
