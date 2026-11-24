import {
  claudeOffer,
  codexOffer,
  effortLevel,
  pickRefusal,
  runtimesOfModel,
  startAgentInput,
  startRuntime,
} from '@seti/shared'
import { describe, expect, it } from 'vitest'

const REPORTED = [
  { value: 'default', display_name: 'Default (recommended)', efforts: ['low', 'high'] },
  { value: 'opus', display_name: 'Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', display_name: 'Haiku' },
]
const OFFERS = [claudeOffer(REPORTED), codexOffer()]

describe("Claude Code's offer", () => {
  it('lists the models a probe reported, without its default, with their efforts', () => {
    expect(claudeOffer(REPORTED)).toEqual({
      runtime: 'claude',
      models: [
        { id: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { id: 'haiku', label: 'Haiku', efforts: [] },
      ],
      default_efforts: ['low', 'high'],
    })
  })

  it('falls back to the stable aliases until a probe reports the models', () => {
    for (const reported of [null, []]) {
      expect(claudeOffer(reported).models).toEqual([
        { id: 'opus', label: 'Opus', efforts: [] },
        { id: 'sonnet', label: 'Sonnet', efforts: [] },
        { id: 'haiku', label: 'Haiku', efforts: [] },
      ])
    }
  })
})

describe('the runtime a model picks', () => {
  it('maps each offered model to the one runtime that runs it', () => {
    expect(runtimesOfModel('gpt-5.5', OFFERS)).toEqual(['codex'])
    expect(runtimesOfModel('opus', OFFERS)).toEqual(['claude'])
    expect(runtimesOfModel('claude-opus-5-5', OFFERS)).toEqual([])
  })

  it('derives the runtime from a model alone and keeps an explicit one', () => {
    expect(startRuntime({}, OFFERS)).toBe('claude')
    expect(startRuntime({ model: 'gpt-5.5' }, OFFERS)).toBe('codex')
    expect(startRuntime({ model: 'opus' }, OFFERS)).toBe('claude')
    expect(startRuntime({ runtime: 'codex' }, OFFERS)).toBe('codex')
  })

  it('accepts a start with no picks, a model alone, or a model with an effort it takes', () => {
    for (const picks of [{}, { model: 'opus' }, { model: 'opus', effort: 'max' }, { effort: 'high' }]) {
      expect(pickRefusal(picks, OFFERS)).toBeNull()
    }
    expect(pickRefusal({ runtime: 'codex', model: 'gpt-5.5', effort: 'xhigh' }, OFFERS)).toBeNull()
  })

  it('refuses an unknown model naming the offered ones, a runtime that disagrees and an effort not taken', () => {
    expect(pickRefusal({ model: 'gpt-4' }, OFFERS)).toBe(
      'No runtime offers gpt-4; a new agent may name opus, haiku, gpt-5.5',
    )
    expect(pickRefusal({ runtime: 'claude', model: 'gpt-5.5' }, OFFERS)).toBe(
      'gpt-5.5 runs on Codex, not on Claude Code',
    )
    expect(pickRefusal({ runtime: 'codex', model: 'opus' }, OFFERS)).toBe('opus runs on Claude Code, not on Codex')
    expect(pickRefusal({ model: 'haiku', effort: 'high' }, OFFERS)).toBe(
      'haiku takes no high effort here; it takes none',
    )
    expect(pickRefusal({ effort: 'max' }, OFFERS)).toBe(
      "Claude Code's default model takes no max effort here; it takes low, high",
    )
  })

  it('checks only the shape of a start: a model id and a known effort', () => {
    const parse = (picks: object) => startAgentInput.safeParse({ prompt: 'port it', ...picks }).success
    expect(parse({ model: 'opus[1m]', effort: 'high' })).toBe(true)
    expect(parse({ model: 'opus; rm -rf' })).toBe(false)
    expect(parse({ effort: 'ultra' })).toBe(false)
    expect(effortLevel('xhigh')).toBe('xhigh')
    expect(effortLevel('ultra')).toBeNull()
  })
})
