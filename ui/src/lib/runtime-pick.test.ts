import type { RuntimeOffer } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import {
  codexHint,
  DEFAULT_PICK,
  effortsOf,
  modelGroups,
  offeredPick,
  pickFields,
  pickOf,
  pickValue,
} from './runtime-pick'

const CLAUDE: RuntimeOffer = {
  runtime: 'claude',
  models: [
    { id: 'opus', label: 'Opus', efforts: ['low', 'max'] },
    { id: 'haiku', label: 'Haiku', efforts: [] },
  ],
  default_efforts: ['low', 'max'],
}
const CLAUDE_ONLY_DEFAULT: RuntimeOffer = { runtime: 'claude', models: [], default_efforts: [] }
const CODEX: RuntimeOffer = {
  runtime: 'codex',
  models: [{ id: 'gpt-5.5', label: 'gpt-5.5', efforts: ['low', 'high'] }],
  default_efforts: ['low', 'high'],
}
const CODEX_PICK = { runtime: 'codex', model: 'gpt-5.5', effort: null } as const
const OPUS_PICK = { runtime: 'claude', model: 'opus', effort: null } as const

describe('the model selector', () => {
  it('groups the offered models by runtime, Claude Code first with its default', () => {
    expect(modelGroups([CLAUDE, CODEX]).map((group) => [group.label, group.options.map((o) => o.label)])).toEqual([
      ['Claude Code', ['Default', 'Opus', 'Haiku']],
      ['Codex', ['gpt-5.5']],
    ])
    expect(modelGroups([CLAUDE_ONLY_DEFAULT]).flatMap((group) => group.options)).toHaveLength(1)
  })

  it('picks the runtime from the model, with the efforts the picked model takes', () => {
    const offers = [CLAUDE, CODEX]
    expect(pickOf(pickValue(CODEX_PICK), offers)).toEqual(CODEX_PICK)
    expect(pickOf(pickValue(OPUS_PICK), offers)).toEqual(OPUS_PICK)
    expect(pickOf(pickValue(DEFAULT_PICK), offers)).toEqual(DEFAULT_PICK)
    expect(pickOf('codex:gpt-9', offers)).toBeNull()
    expect(effortsOf(CODEX_PICK, offers)).toEqual(['low', 'high'])
    expect(effortsOf(OPUS_PICK, offers)).toEqual(['low', 'max'])
    expect(effortsOf({ ...OPUS_PICK, model: 'haiku' }, offers)).toEqual([])
    expect(effortsOf(DEFAULT_PICK, offers)).toEqual([])
  })

  it('falls back to the default once a model is no longer offered, and keeps a valid effort', () => {
    expect(offeredPick({ ...CODEX_PICK, effort: 'high' }, [CLAUDE])).toEqual(DEFAULT_PICK)
    expect(offeredPick({ ...CODEX_PICK, effort: 'high' }, [CLAUDE, CODEX])).toEqual({ ...CODEX_PICK, effort: 'high' })
    expect(offeredPick({ ...CODEX_PICK, effort: 'max' }, [CLAUDE, CODEX])).toEqual(CODEX_PICK)
    expect(offeredPick(DEFAULT_PICK, [])).toEqual(DEFAULT_PICK)
  })

  it('sends nothing for the default and the runtime with its picks otherwise', () => {
    expect(pickFields(DEFAULT_PICK)).toEqual({})
    expect(pickFields({ ...OPUS_PICK, effort: 'max' })).toEqual({ runtime: 'claude', model: 'opus', effort: 'max' })
    expect(pickFields(CODEX_PICK)).toEqual({ runtime: 'codex', model: 'gpt-5.5' })
  })

  it('says a Codex start asks only when the rules do not decide', () => {
    expect(codexHint(false)).toBe('Codex: sandboxed; asks before each call.')
    expect(codexHint(true)).toBe('Codex: sandboxed; asks unless rules allow.')
  })
})
