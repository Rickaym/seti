import { describe, expect, it } from 'vitest'
import { explainMcpError } from './mcp-error'

describe('explainMcpError', () => {
  it('names the common causes in plain words', () => {
    expect(explainMcpError('connect ECONNREFUSED 127.0.0.1:8931')).toMatch(/^Nothing answers at the server address/)
    expect(explainMcpError('getaddrinfo ENOTFOUND mcp.example.invalid')).toMatch(/does not resolve/)
    expect(explainMcpError('SSE error: Non-200 status code (401)')).toMatch(/refused the credentials/)
    expect(explainMcpError('spawn uvx ENOENT')).toMatch(/command was not found/)
    expect(explainMcpError('sh: mcp-server: command not found')).toMatch(/command was not found/)
    expect(explainMcpError('MCP server exited with code 1')).toMatch(/exited while starting/)
  })

  it('falls back to a generic sentence', () => {
    expect(explainMcpError('something odd happened')).toBe('The server failed to connect.')
  })
})
