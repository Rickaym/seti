import { describe, expect, it } from 'vitest'
import { ServerStatus } from './server-status.js'

const update = (params: Record<string, unknown>) => ({ method: 'mcpServer/startupStatus/updated', params })

describe("a Codex session's tool servers", () => {
  it('holds every server it starts as pending until Codex reports how it started', () => {
    const status = new ServerStatus(['-c', 'mcp_servers.play.command="npx"', '-c', 'mcp_servers.docs.url="https://d"'])
    expect(status.list().map((s) => [s.name, s.status])).toEqual([
      ['docs', 'pending'],
      ['play', 'pending'],
    ])
    status.note(update({ threadId: null, name: 'play', status: 'ready', error: null, failureReason: null }))
    status.note(update({ name: 'docs', status: 'failed', error: 'refused', failureReason: null }))
    expect(status.list()).toEqual([
      { name: 'docs', status: 'failed', error: 'refused', transport: 'http' },
      { name: 'play', status: 'connected', transport: 'stdio' },
    ])
  })

  it('says a server needs a sign-in when Codex reports its sign-in expired', () => {
    const status = new ServerStatus([])
    status.note(update({ name: 'docs', status: 'failed', error: null, failureReason: 'reauthenticationRequired' }))
    status.note({ method: 'turn/started', params: {} })
    expect(status.list()).toEqual([{ name: 'docs', status: 'needs-auth', transport: null }])
  })
})
