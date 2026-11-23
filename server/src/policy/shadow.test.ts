import { shadowSince } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { shadowCheck } from '../doctor.js'
import { ShadowTracker, type CallFacts, type ShadowRecord } from './shadow.js'
import type { Decision } from './types.js'

const facts: CallFacts = { kind: 'shell', tool: 'Bash', mode: 'auto', sandboxed: true, slow: false }
const allow: Decision = { verdict: 'allow', step: 'allow-rule', rule: 'rule:1', reason: '' }
const defer: Decision = { verdict: 'defer', step: 'mode', rule: null, reason: '' }

function tracked(): { tracker: ShadowTracker; records: ShadowRecord[] } {
  const records: ShadowRecord[] = []
  return { tracker: new ShadowTracker((record) => records.push(record)), records }
}

describe('pairing decisions with what the runtime did', () => {
  it('hands a call on once both sides are known, whichever came first', () => {
    const { tracker, records } = tracked()
    tracker.decided('a', facts, allow)
    tracker.observed('b', 'ask')
    expect(records).toEqual([])
    tracker.observed('a', 'allow')
    tracker.decided('b', facts, defer)
    expect(records).toEqual([
      { ...facts, verdict: 'allow', step: 'allow-rule', rule: 'rule:1', runtime: 'allow', result: 'agree' },
      { ...facts, verdict: 'defer', step: 'mode', rule: '', runtime: 'ask', result: 'looser' },
    ])
  })

  it('keeps what the runtime did first: an ask stays an ask once the user allows the call', () => {
    const { tracker, records } = tracked()
    tracker.observed('a', 'ask')
    tracker.observed('a', 'allow')
    tracker.decided('a', facts, allow)
    tracker.observed('a', 'allow')
    expect(records.map((record) => [record.runtime, record.result])).toEqual([['ask', 'looser']])
  })

  it('sets interrupted calls apart and closes undecided ones as unobserved', () => {
    const { tracker, records } = tracked()
    tracker.decided('a', facts, allow)
    tracker.observed('a', 'interrupted')
    tracker.decided('b', facts, defer)
    tracker.observed('c', 'allow')
    tracker.close()
    expect(records.map((record) => record.result)).toEqual(['interrupted', 'unobserved'])
  })

  it("keeps a call Seti's own hooks refused apart, even when the runtime shows nothing of it", () => {
    const { tracker, records } = tracked()
    tracker.decided('a', facts, { verdict: 'deny', step: 'guard', rule: null, reason: '' })
    tracker.close()
    expect(records.map((record) => [record.runtime, record.result])).toEqual([['unobserved', 'seti-hook']])
  })
})

describe("auto mode's pause after repeated classifier blocks", () => {
  const block = (tracker: ShadowTracker, ids: readonly string[]) => {
    for (const id of ids) {
      tracker.decided(id, facts, defer)
      tracker.observed(id, 'deny')
    }
  }
  const askedAbout = (tracker: ShadowTracker, id: string, decision: Decision = defer) => {
    tracker.decided(id, facts, decision)
    tracker.observed(id, 'ask')
  }
  const results = (records: readonly ShadowRecord[]) => records.slice(-1).map((record) => record.result)

  it('counts a deferred call asked about after 3 blocks in a row as deferred, not looser', () => {
    const { tracker, records } = tracked()
    block(tracker, ['b1', 'b2'])
    askedAbout(tracker, 'early')
    expect(results(records)).toEqual(['looser'])
    block(tracker, ['b3'])
    askedAbout(tracker, 'paused')
    expect(results(records)).toEqual(['deferred'])
    askedAbout(tracker, 'by-rule', allow)
    expect(results(records)).toEqual(['looser'])
  })

  it('resumes once a call runs, the asked one approved included', () => {
    const { tracker, records } = tracked()
    block(tracker, ['b1', 'b2', 'b3'])
    askedAbout(tracker, 'paused')
    tracker.observed('paused', 'allow')
    askedAbout(tracker, 'resumed')
    expect(records.map((record) => record.result).slice(-2)).toEqual(['deferred', 'looser'])
  })

  it('pauses after 20 blocks in all, and counts the total again from there', () => {
    const { tracker, records } = tracked()
    for (let i = 0; i < 9; i += 1) {
      block(tracker, [`x${String(i)}`, `y${String(i)}`])
      tracker.observed(`ran${String(i)}`, 'allow')
    }
    block(tracker, ['b19'])
    askedAbout(tracker, 'nineteen')
    expect(results(records)).toEqual(['looser'])
    block(tracker, ['b20'])
    askedAbout(tracker, 'twenty')
    expect(results(records)).toEqual(['deferred'])
    tracker.observed('ran', 'allow')
    block(tracker, ['c1', 'c2'])
    askedAbout(tracker, 'counted-again')
    expect(results(records)).toEqual(['looser'])
  })
})

describe('the doctor line', () => {
  it('counts the last seven days, today included', () => {
    expect(shadowSince(7, new Date('2026-11-22T10:00:00Z'))).toBe('2026-11-16')
  })

  it('says how many calls matched and how the rest differed', () => {
    expect(shadowCheck({ agree: 90, deferred: 6, tighter: 3, looser: 1, 'seti-hook': 4 })).toEqual({
      section: 'Permissions',
      state: 'info',
      label:
        "last 7 days: Seti's own decision matched Claude Code on 90 of 100 calls; 6 left to its classifier, " +
        '3 stricter, 1 looser',
    })
    expect(shadowCheck({}).label).toBe('no tool calls compared with Claude Code in the last 7 days')
  })

  it('warns when decisions failed or ran slow', () => {
    expect(shadowCheck({ agree: 5, failed: 2, slow: 1 })).toEqual({
      section: 'Permissions',
      state: 'warn',
      label:
        "last 7 days: Seti's own decision matched Claude Code on 5 of 5 calls; 0 left to its classifier, " +
        '0 stricter, 0 looser; 2 failed, 1 slow',
    })
    expect(shadowCheck({ failed: 3 }).label).toBe(
      'no tool calls compared with Claude Code in the last 7 days; 3 failed',
    )
  })
})
