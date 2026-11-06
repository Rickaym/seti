import { describe, expect, it } from 'vitest'
import { lastSegment, modelLabel, permissionLabel, plural, turnOutcome } from '@/lib/session-labels'

describe('modelLabel', () => {
  it('names the family and version of a model id', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelLabel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
    expect(modelLabel('claude-3-5-haiku-20241022')).toBe('Haiku 3.5')
    expect(modelLabel('claude-fable')).toBe('Fable')
  })

  it('marks the million-token context and drops a provider prefix', () => {
    expect(modelLabel('claude-opus-4-6[1m]')).toBe('Opus 4.6 1M')
    expect(modelLabel('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('Sonnet 4.5')
  })

  it('keeps an id it cannot read', () => {
    expect(modelLabel('gpt-5')).toBe('gpt-5')
    expect(modelLabel('claude-3-5')).toBe('claude-3-5')
  })
})

describe('permissionLabel', () => {
  it('shortens the known modes and keeps an unknown one', () => {
    expect(permissionLabel('bypassPermissions')).toBe('bypass')
    expect(permissionLabel('acceptEdits')).toBe('accept edits')
    expect(permissionLabel('somethingNew')).toBe('somethingNew')
  })
})

describe('lastSegment', () => {
  it('keeps the last folder of a path', () => {
    expect(lastSegment('/home/user/work/poller-2b3364bf')).toBe('poller-2b3364bf')
    expect(lastSegment('/home/user/seti/')).toBe('seti')
    expect(lastSegment('/')).toBe('/')
  })
})

describe('turnOutcome', () => {
  it('reads a finished, interrupted or failed turn in plain words', () => {
    expect(turnOutcome({ subtype: 'success', is_error: false }, false)).toBe('Turn done')
    expect(turnOutcome({ subtype: 'error_during_execution', is_error: true }, true)).toBe('Turn interrupted')
    expect(turnOutcome({ subtype: 'error_during_execution', is_error: true }, false)).toBe(
      'Turn failed: error during execution',
    )
    expect(turnOutcome({ subtype: 'error_max_turns', is_error: true }, false)).toBe('Turn failed: hit the step limit')
    expect(turnOutcome({ subtype: 'success', is_error: true }, false)).toBe('Turn failed')
  })
})

describe('plural', () => {
  it('counts one noun or many', () => {
    expect(plural(1, 'step')).toBe('1 step')
    expect(plural(5, 'step')).toBe('5 steps')
  })
})
