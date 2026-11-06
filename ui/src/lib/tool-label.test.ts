import { describe, expect, it } from 'vitest'
import { toolLabel } from './tool-label'

describe('toolLabel', () => {
  it('names an MCP tool by its server and tool, and others by name', () => {
    expect(toolLabel('mcp__linear__create_issue')).toBe('linear create_issue')
    expect(toolLabel('mcp__a__b__c')).toBe('a b__c')
    expect(toolLabel('Bash')).toBe('Bash')
    expect(toolLabel('mcp__server')).toBe('mcp__server')
  })
})
