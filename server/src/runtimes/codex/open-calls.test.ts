import { describe, expect, it } from 'vitest'
import { OpenCalls } from './open-calls.js'

const ROOT = 'thread-root'

const note = (method: string, id: string, type = 'commandExecution', threadId = ROOT) => ({
  method,
  params: { threadId, item: { type, id } },
})
const turnEnd = (threadId = ROOT) => ({ method: 'turn/completed', params: { threadId, turn: { id: 't' } } })

describe("the agent's open calls", () => {
  it('names the calls a turn ends without completing, once, and leaves background commands alone', () => {
    const open = new OpenCalls(() => ROOT)
    for (const id of ['done', 'asked', 'edit', 'job']) {
      open.note(note('item/started', id, id === 'edit' ? 'fileChange' : 'commandExecution'))
    }
    open.note(note('item/completed', 'done'))
    open.note(note('item/started', 'said', 'agentMessage'))
    open.note(note('item/started', 'sub', 'commandExecution', 'thread-child'))
    expect(open.leftBy(turnEnd(), (id) => id === 'job')).toEqual(['asked', 'edit'])
    expect(open.leftBy(turnEnd(), (id) => id === 'job')).toEqual([])
  })

  it("ignores a subagent's turn end and any other message", () => {
    const open = new OpenCalls(() => ROOT)
    open.note(note('item/started', 'asked'))
    expect(open.leftBy(turnEnd('thread-child'), () => false)).toEqual([])
    expect(open.leftBy(note('item/completed', 'other'), () => false)).toEqual([])
    expect(open.leftBy(turnEnd(), () => false)).toEqual(['asked'])
  })
})
