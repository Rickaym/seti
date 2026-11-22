import { describe, expect, it } from 'vitest'
import { shadowCheck, shadowSince } from '../doctor.js'
import { ShadowTracker, type CallFacts, type ShadowRecord } from './shadow.js'
import type { Decision } from './types.js'

const facts: CallFacts = { kind: 'shell', tool: 'Bash', mode: 'auto', sandboxed: true }
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
})

describe('the doctor line', () => {
  it('counts the last seven days, today included', () => {
    expect(shadowSince(new Date('2026-11-22T10:00:00Z'))).toBe('2026-11-16')
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
})
