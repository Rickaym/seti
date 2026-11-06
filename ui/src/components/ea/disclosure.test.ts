import { describe, expect, it } from 'vitest'
import { closedDisclosure, disclosureReducer, isOpen, type DisclosureEvent } from './disclosure'

const run = (events: DisclosureEvent[]) => events.reduce(disclosureReducer, closedDisclosure)

describe('disclosureReducer', () => {
  it('stays open while the pointer or keyboard focus is inside', () => {
    const state = run([
      { type: 'hover', inside: true },
      { type: 'focus', inside: true },
      { type: 'hover', inside: false },
    ])
    expect(isOpen(state)).toBe(true)
    expect(isOpen(disclosureReducer(state, { type: 'focus', inside: false }))).toBe(false)
  })

  it('opens on a click and closes on the next one, even while hovered', () => {
    const tapped = run([{ type: 'toggle' }])
    expect(tapped.pinned).toBe(true)
    expect(isOpen(disclosureReducer(tapped, { type: 'hover', inside: false }))).toBe(true)
    expect(run([{ type: 'hover', inside: true }, { type: 'toggle' }])).toEqual(closedDisclosure)
  })

  it('dismisses every reason at once and keeps the state when nothing changes', () => {
    const open = run([{ type: 'pin' }, { type: 'hover', inside: true }, { type: 'focus', inside: true }])
    expect(disclosureReducer(open, { type: 'dismiss' })).toEqual(closedDisclosure)
    expect(disclosureReducer(open, { type: 'pin' })).toBe(open)
    expect(disclosureReducer(closedDisclosure, { type: 'dismiss' })).toBe(closedDisclosure)
  })
})
