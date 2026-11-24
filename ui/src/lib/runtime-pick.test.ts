import type { RuntimeOffer } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PICK, effortsOf, modelGroups, offeredPick, pickFields, pickOf, pickValue } from './runtime-pick'

const CLAUDE: RuntimeOffer = { runtime: 'claude', models: [], efforts: [] }
const CODEX: RuntimeOffer = { runtime: 'codex', models: ['gpt-5.5'], efforts: ['low', 'high'] }
const CODEX_PICK = { runtime: 'codex', model: 'gpt-5.5', effort: null } as const

describe('the model selector', () => {
  it('groups the offered models by runtime, Claude Code first with its default', () => {
    expect(modelGroups([CLAUDE, CODEX])).toEqual([
      {
        runtime: 'claude',
        label: 'Claude Code',
        options: [expect.objectContaining({ label: 'Default', model: null })],
      },
      { runtime: 'codex', label: 'Codex', options: [expect.objectContaining({ label: 'gpt-5.5', model: 'gpt-5.5' })] },
    ])
    expect(modelGroups([CLAUDE]).flatMap((group) => group.options)).toHaveLength(1)
  })

  it('picks the runtime from the model, with efforts only where the runtime has them', () => {
    const offers = [CLAUDE, CODEX]
    expect(pickOf(pickValue(CODEX_PICK), offers)).toEqual(CODEX_PICK)
    expect(pickOf(pickValue(DEFAULT_PICK), offers)).toEqual(DEFAULT_PICK)
    expect(pickOf('codex:gpt-9', offers)).toBeNull()
    expect(effortsOf(CODEX_PICK, offers)).toEqual(['low', 'high'])
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
    expect(pickFields({ ...CODEX_PICK, effort: 'high' })).toEqual({
      runtime: 'codex',
      model: 'gpt-5.5',
      effort: 'high',
    })
    expect(pickFields(CODEX_PICK)).toEqual({ runtime: 'codex', model: 'gpt-5.5' })
  })
})
