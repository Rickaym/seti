import { createTaskInput, pickRefusal, runtimesOfModel, startAgentInput, startRuntime } from '@seti/shared'
import { describe, expect, it } from 'vitest'

const start = (picks: object) => startAgentInput.safeParse({ prompt: 'port it', ...picks })
const refusal = (picks: object) => {
  const parsed = start(picks)
  return parsed.success ? null : parsed.error.issues.map((issue) => issue.message).join('; ')
}

describe('the runtime a model picks', () => {
  it('maps each offered model to the one runtime that runs it', () => {
    expect(runtimesOfModel('gpt-5.5')).toEqual(['codex'])
    expect(runtimesOfModel('claude-opus-5-5')).toEqual([])
  })

  it('derives the runtime from a model alone and keeps an explicit one', () => {
    expect(startRuntime({})).toBe('claude')
    expect(startRuntime({ model: 'gpt-5.5' })).toBe('codex')
    expect(startRuntime({ runtime: 'codex' })).toBe('codex')
    expect(startRuntime({ runtime: 'claude', model: 'gpt-5.5' })).toBe('claude')
  })

  it('accepts a start with no picks, a model alone, or a runtime with its model and effort', () => {
    expect(start({}).success).toBe(true)
    expect(start({}).data?.runtime).toBeUndefined()
    expect(refusal({ model: 'gpt-5.5', effort: 'high' })).toBeNull()
    expect(refusal({ runtime: 'codex', model: 'gpt-5.5', effort: 'max' })).toBeNull()
    expect(refusal({ runtime: 'codex' })).toBeNull()
    expect(createTaskInput.safeParse({ prompt: 'port it', model: 'gpt-5.5' }).success).toBe(true)
  })

  it('refuses an unknown model, a runtime that disagrees and an effort its runtime lacks, with the reason', () => {
    expect(refusal({ model: 'claude-opus-5-5' })).toBe(
      'No runtime offers claude-opus-5-5; a new agent may name gpt-5.5',
    )
    expect(refusal({ runtime: 'claude', model: 'gpt-5.5' })).toBe('gpt-5.5 runs on Codex, not on Claude Code')
    expect(refusal({ effort: 'high' })).toBe('Claude Code takes no effort here; name a model that has one')
    expect(refusal({ runtime: 'claude', effort: 'low' })).toContain('Claude Code takes no effort')
    expect(pickRefusal({ model: 'gpt-4' })).toContain('No runtime offers gpt-4')
  })
})
