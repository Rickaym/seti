import { describe, expect, it } from 'vitest'
import { kept, keptMessage, OPTED_OUT } from './private.js'

const thread = {
  id: 't1',
  cwd: '/work/project',
  path: '/home/someone/.codex/sessions/2026/11/23/rollout-t1.jsonl',
  gitInfo: { sha: 'abc', branch: 'main', originUrl: 'https://user:secret@example.com/o/r.git' },
}

describe('what Seti keeps of a Codex message', () => {
  it("drops a thread's rollout path and a remote's credentials, and keeps the rest", () => {
    const message = keptMessage({ method: 'thread/started', params: { thread } })
    expect(message).toEqual({
      method: 'thread/started',
      params: {
        thread: {
          id: 't1',
          cwd: '/work/project',
          gitInfo: { sha: 'abc', branch: 'main', originUrl: 'https://example.com/o/r.git' },
        },
      },
    })
  })

  it('treats a reply that holds a thread the same way, and leaves other bodies alone', () => {
    expect(kept({ thread: { id: 't1', path: '/home/someone/.codex/x.jsonl' } })).toEqual({ thread: { id: 't1' } })
    const plain = { threadId: 't1', turn: { id: 'u1' } }
    expect(keptMessage({ method: 'turn/started', params: plain }).params).toBe(plain)
    const bare = { id: 't1', gitInfo: { originUrl: 'git@example.com:o/r.git' } }
    expect(kept({ thread: bare })).toEqual({ thread: bare })
  })

  it("asks Codex not to send remote control's status, which names the host", () => {
    expect(OPTED_OUT).toContain('remoteControl/status/changed')
  })
})
