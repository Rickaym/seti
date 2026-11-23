import { randomUUID } from 'node:crypto'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { messages, tasks } from './db.js'
import { restoreToolCalls } from './tool-calls-restore.js'
import { currentToolCall, forgetToolCalls } from './tool-calls.js'

const call = (id: string, command: string): SDKMessage =>
  ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
    parent_tool_use_id: null,
  }) as unknown as SDKMessage

const result = (id: string): SDKMessage =>
  ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    parent_tool_use_id: null,
  }) as unknown as SDKMessage

describe('tool calls after a control plane restart', () => {
  it('shows the calls of an open session that have no result yet', async () => {
    const taskId = `restore-${randomUUID()}`
    await tasks.insert({ id: taskId, title: 'Restore', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
    const prompt = await messages.insert(taskId, { kind: 'prompt', payload: { text: 'go' } }, [])
    await messages.insert(taskId, { kind: 'sdk', payload: call('done-1', 'git status') }, [])
    await messages.insert(taskId, { kind: 'sdk', payload: result('done-1') }, [])
    await messages.insert(taskId, { kind: 'sdk', payload: call('open-1', 'make test') }, [])
    forgetToolCalls(taskId)

    await restoreToolCalls(taskId, prompt.id)
    expect(currentToolCall(taskId)).toMatchObject({ name: 'Bash', command: 'make test' })
  })
})
