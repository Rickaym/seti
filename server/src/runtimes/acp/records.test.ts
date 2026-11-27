import { describe, expect, it } from 'vitest'
import { namingServer } from './records.js'

const call = (toolCallId: string, extra: Record<string, unknown> = {}) => ({
  sessionUpdate: 'tool_call',
  toolCallId,
  title: 'post_message(text: hi)',
  kind: 'other',
  ...extra,
})

describe("a tool server call's stored update", () => {
  it('names the server and tool Seti handed the agent, the longest server name first', () => {
    const update = namingServer(call('mcp_seti_tools_post_message__mcp_seti_tools_post_message_1_0'), [
      'seti',
      'seti_tools',
    ])
    expect(update).toMatchObject({
      _meta: { 'gemini-cli': { mcp: { server_name: 'seti_tools', tool_name: 'post_message' } } },
    })
  })

  it('leaves alone a call of another server, a built-in tool, or one that names itself', () => {
    const named = call('mcp_seti_a__1', { _meta: { 'gemini-cli': { mcp: { server_name: 'x', tool_name: 'y' } } } })
    for (const update of [call('mcp_other_post__1'), call('run_shell_command__run_shell_command_1_0'), named]) {
      expect(namingServer(update, ['seti'])).toBe(update)
    }
    expect(namingServer(call('mcp_seti___1'), ['seti'])).toEqual(call('mcp_seti___1'))
  })
})
