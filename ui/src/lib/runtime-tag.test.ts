import { describe, expect, it } from 'vitest'
import { runtimeTag } from './runtime-tag'

describe('a runtime tag', () => {
  it('says nothing while every runtime that is on can use the row', () => {
    expect(runtimeTag(['claude'], ['claude'])).toBeNull()
    expect(runtimeTag(['claude', 'codex'], ['claude', 'codex'])).toBeNull()
  })

  it('names the one runtime that can, and the ones that cannot in its tooltip', () => {
    expect(runtimeTag(['claude'], ['claude', 'codex'])).toEqual({ label: 'Claude only', missing: 'Codex' })
    expect(runtimeTag(['codex'], ['claude', 'codex'])).toEqual({ label: 'Codex only', missing: 'Claude Code' })
  })

  it('says which runtime cannot when none of those on can', () => {
    expect(runtimeTag([], ['claude', 'codex'])).toEqual({
      label: 'Not on Claude Code and Codex',
      missing: 'Claude Code and Codex',
    })
  })
})
