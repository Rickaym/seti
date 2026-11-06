import { describe, expect, it } from 'vitest'
import { ModSwitches } from './switches'

const counter = () => {
  const state = { live: 0 }
  const register = () => {
    state.live += 1
    return () => {
      state.live -= 1
    }
  }
  return { state, register }
}

describe('a mod switch', () => {
  it('registers only while its setting is on, and undoes only the switch that changed', () => {
    const pdf = counter()
    const sheets = counter()
    const switches = new ModSwitches(['pdf'])
    switches.add('pdf', pdf.register)
    const dispose = switches.add('sheets', sheets.register)
    expect([pdf.state.live, sheets.state.live]).toEqual([0, 1])

    switches.apply([])
    expect([pdf.state.live, sheets.state.live]).toEqual([1, 1])
    switches.apply(['sheets'])
    expect([pdf.state.live, sheets.state.live]).toEqual([1, 0])
    switches.apply(['sheets'])
    expect([pdf.state.live, sheets.state.live]).toEqual([1, 0])

    dispose()
    switches.apply([])
    expect([pdf.state.live, sheets.state.live]).toEqual([1, 0])
  })
})
