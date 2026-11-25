import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { editNoteHooks } from './edit-note-hooks.js'

const signal = new AbortController().signal

const after = (id: string, event: 'PostToolUse' | 'PostToolUseFailure' = 'PostToolUse'): HookInput =>
  event === 'PostToolUse'
    ? {
        session_id: 's',
        transcript_path: '',
        cwd: '/tmp',
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__chat__send',
        tool_input: {},
        tool_response: 'ok',
        tool_use_id: id,
      }
    : {
        session_id: 's',
        transcript_path: '',
        cwd: '/tmp',
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'mcp__chat__send',
        tool_input: {},
        error: 'failed',
        tool_use_id: id,
      }

async function fire(hooks: ReturnType<typeof editNoteHooks>, input: HookInput) {
  const [matcher] = input.hook_event_name === 'PostToolUse' ? hooks.PostToolUse : hooks.PostToolUseFailure
  const [hook] = matcher?.hooks ?? []
  return hook?.(input, undefined, { signal })
}

describe('edit note hooks', () => {
  it('add the note once, after the result of the edited call only', async () => {
    const hooks = editNoteHooks()
    hooks.keep('toolu_1', 'Edited.')
    expect(await fire(hooks, after('toolu_2'))).toEqual({})
    expect(await fire(hooks, after('toolu_1'))).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'Edited.' },
    })
    expect(await fire(hooks, after('toolu_1'))).toEqual({})
  })

  it('add the note after a failed result too', async () => {
    const hooks = editNoteHooks()
    hooks.keep('toolu_1', 'Edited.')
    expect(await fire(hooks, after('toolu_1', 'PostToolUseFailure'))).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: 'Edited.' },
    })
  })

  it('keep nothing for an answer without a note or a call without an id', async () => {
    const hooks = editNoteHooks()
    hooks.keep('toolu_1', undefined)
    hooks.keep(undefined, 'Edited.')
    expect(await fire(hooks, after('toolu_1'))).toEqual({})
  })

  it('keep at most a hundred notes, dropping the oldest', async () => {
    const hooks = editNoteHooks()
    for (let index = 0; index <= 100; index += 1) {
      hooks.keep(`toolu_${String(index)}`, `Edited ${String(index)}.`)
    }
    expect(await fire(hooks, after('toolu_0'))).toEqual({})
    expect(await fire(hooks, after('toolu_100'))).toMatchObject({
      hookSpecificOutput: { additionalContext: 'Edited 100.' },
    })
  })
})
