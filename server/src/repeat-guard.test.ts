import { describe, expect, it } from 'vitest'
import { callKey, repeatReason, RepeatTracker, resultKey } from './repeat-guard.js'

const build = callKey('Bash', { command: 'pnpm build' })
const failed = resultKey({ stdout: 'error TS2304', stderr: '', interrupted: false })

describe('repeat tracker', () => {
  it('asks on the third identical call once two identical results came back', () => {
    const tracker = new RepeatTracker()
    expect(tracker.repeats('', build)).toBe(0)
    tracker.ran('', build, failed)
    expect(tracker.repeats('', build)).toBe(0)
    tracker.ran('', build, failed)
    expect(tracker.repeats('', build)).toBe(2)
    expect(tracker.repeats('', callKey('Bash', { command: 'pnpm test' }))).toBe(0)
  })

  it('counts nothing when the same call gives a different result each time', () => {
    const tracker = new RepeatTracker()
    for (const stdout of ['1 pending', '2 pending', '3 pending', '4 pending']) {
      tracker.ran('', build, resultKey({ stdout }))
      expect(tracker.repeats('', build)).toBe(0)
    }
  })

  it('starts again after a different call in between', () => {
    const tracker = new RepeatTracker()
    tracker.ran('', build, failed)
    tracker.ran('', callKey('Read', { file_path: '/repo/src/app.ts' }), resultKey('code'))
    tracker.ran('', build, failed)
    expect(tracker.repeats('', build)).toBe(0)
  })

  it('counts each subagent apart from the agent and from each other', () => {
    const tracker = new RepeatTracker()
    for (const thread of ['', 'agent-a', 'agent-b']) {
      tracker.ran(thread, build, failed)
    }
    expect(['', 'agent-a', 'agent-b'].map((thread) => tracker.repeats(thread, build))).toEqual([0, 0, 0])
    tracker.ran('agent-a', build, failed)
    expect(['', 'agent-a', 'agent-b'].map((thread) => tracker.repeats(thread, build))).toEqual([0, 2, 0])
  })

  it('starts the count again on Allow, and stops asking about the call on Always', () => {
    const tracker = new RepeatTracker()
    tracker.ran('', build, failed)
    tracker.ran('', build, failed)
    tracker.allowed('', build, false)
    expect(tracker.repeats('', build)).toBe(0)
    tracker.ran('', build, failed)
    tracker.ran('', build, failed)
    expect(tracker.repeats('', build)).toBe(2)
    tracker.allowed('', build, true)
    for (let run = 0; run < 5; run += 1) {
      tracker.ran('', build, failed)
    }
    expect(tracker.repeats('', build)).toBe(0)
  })

  it('starts every count again on a message from the user', () => {
    const tracker = new RepeatTracker()
    tracker.ran('', build, failed)
    tracker.ran('', build, failed)
    tracker.ran('agent-a', build, failed)
    tracker.ran('agent-a', build, failed)
    tracker.resetAll()
    expect([tracker.repeats('', build), tracker.repeats('agent-a', build)]).toEqual([0, 0])
  })
})

describe('call and result keys', () => {
  it('ignore key order, a Bash description and fields that change on every run', () => {
    expect(callKey('Bash', { command: 'gh pr checks 12', description: 'Check CI' })).toBe(
      callKey('Bash', { description: 'Check CI again', command: 'gh pr checks 12' }),
    )
    expect(callKey('Bash', { command: 'ls' })).not.toBe(callKey('Bash', { command: 'ls -a' }))
    expect(callKey('Bash', { command: 'ls' })).not.toBe(callKey('Agent', { command: 'ls' }))
    expect(callKey('TaskCreate', { description: 'a' })).not.toBe(callKey('TaskCreate', { description: 'b' }))
    expect(resultKey({ stdout: 'x', durationMs: 12, rawOutputPath: '/out/a' })).toBe(
      resultKey({ durationMs: 40, stdout: 'x', rawOutputPath: '/out/b' }),
    )
    expect(resultKey({ stdout: 'x' })).not.toBe(resultKey({ stdout: 'y' }))
    expect(resultKey(undefined)).toBe(resultKey(undefined))
  })

  it('keep no copy of the input or the output', () => {
    const key = callKey('Bash', { command: 'echo hunter2' })
    expect(key).not.toContain('hunter2')
    expect(key).toMatch(/^[\w-]{43}$/)
  })

  it('name what repeated in the reason line', () => {
    expect(repeatReason('Bash', 2)).toBe('Runs the same Bash command again after 2 identical results')
    expect(repeatReason('Read', 3)).toBe('Runs the same Read call again after 3 identical results')
  })
})
