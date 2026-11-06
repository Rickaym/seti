import { AGENT_COLOR_PRESETS } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { pickAgentColor } from './new-agent-color.js'

const HEXES = AGENT_COLOR_PRESETS.map((preset) => preset.hex)
const hexOf = (name: string) => AGENT_COLOR_PRESETS.find((preset) => preset.name === name)?.hex ?? ''

describe('pickAgentColor', () => {
  it('picks any preset when none is in use, as the random source decides', () => {
    expect(pickAgentColor([], () => 0)).toBe(HEXES[0])
    expect(pickAgentColor([], () => 0.5)).toBe(HEXES[7])
    expect(pickAgentColor([], () => 0.999)).toBe(HEXES.at(-1))
  })

  it('picks only among the presets used least', () => {
    const allButTeal = HEXES.filter((hex) => hex !== hexOf('teal'))
    for (const random of [0, 0.3, 0.999]) {
      expect(pickAgentColor(allButTeal, () => random)).toBe(hexOf('teal'))
    }
    const redAndBlueThrice = [...HEXES, ...HEXES, hexOf('red'), hexOf('blue')]
    const left = HEXES.filter((hex) => hex !== hexOf('red') && hex !== hexOf('blue'))
    expect(pickAgentColor(redAndBlueThrice, () => 0)).toBe(left[0])
    expect(pickAgentColor(redAndBlueThrice, () => 0.999)).toBe(left.at(-1))
  })

  it('ignores colours that are not presets', () => {
    expect(pickAgentColor(['#123456', '#3388ff', ...HEXES.slice(1)], () => 0.7)).toBe(HEXES[0])
  })

  it('always returns a preset with the default random source', () => {
    for (let n = 0; n < 50; n += 1) {
      expect(HEXES).toContain(pickAgentColor([hexOf('green')]))
    }
    expect(pickAgentColor([hexOf('green')])).not.toBe(hexOf('green'))
  })
})
