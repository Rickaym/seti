import { describe, expect, it } from 'vitest'
import { BODY } from './Face'
import { blobLook, blobSettings, DEFAULT_SETTINGS, EXPRESSION, showsIn, SIZE_PX, SIZES, type Expression } from './look'
import manifest from './seti-mod.json' with { type: 'json' }

const STATUSES = Object.keys(EXPRESSION) as (keyof typeof EXPRESSION)[]
const ids = Array.from({ length: 200 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)

describe('blob expressions', () => {
  it('reads happy while running, asleep while idle and neutral once stopped or cut off', () => {
    const want: Record<keyof typeof EXPRESSION, Expression> = {
      running: 'happy',
      asking: 'asking',
      blocked: 'alert',
      idle: 'asleep',
      complete: 'content',
      stopped: 'neutral',
      error: 'error',
      interrupted: 'neutral',
    }
    for (const status of STATUSES) {
      expect(blobLook(status, 'agent').expression).toBe(want[status])
    }
  })
})

describe('blob timing and body', () => {
  it('keeps one timing per agent whatever its status', () => {
    for (const id of ids.slice(0, 20)) {
      expect(new Set(STATUSES.map((status) => blobLook(status, id).delay)).size).toBe(1)
    }
  })

  it('starts running blobs at one of six points of the cycle, so they wake the page rarely', () => {
    const delays = new Set(ids.map((id) => blobLook('running', id).delay))
    expect(delays).toEqual(new Set(['-0ms', '-800ms', '-1600ms', '-2400ms', '-3200ms', '-4000ms']))
  })

  it('starts with no offset when no agent is given', () => {
    expect(blobLook('running', null)).toEqual({ expression: 'happy', delay: '-0ms' })
  })

  it('draws the body as one closed curve inside the 24 by 24 box', () => {
    expect(BODY).toMatch(/^M[\d. ]+C[\d. ]+S[\d. ]+Z$/)
    const numbers = BODY.match(/\d+(\.\d+)?/g)?.map(Number) ?? []
    expect(Math.min(...numbers)).toBeGreaterThanOrEqual(2)
    expect(Math.max(...numbers)).toBeLessThanOrEqual(22)
  })
})

describe('blob settings', () => {
  it('declares size, animation and the three places with the defaults the code uses', () => {
    const { settings } = manifest.contributes
    expect(Object.keys(settings)).toEqual(['size', 'animation', 'list', 'needs-you', 'grid'])
    expect(settings.size).toMatchObject({ type: 'string', default: DEFAULT_SETTINGS.size, options: [...SIZES] })
    expect(settings.animation).toMatchObject({ type: 'boolean', default: true })
    for (const place of ['list', 'needs-you', 'grid'] as const) {
      expect(settings[place]).toMatchObject({ type: 'boolean', default: true })
    }
    expect(blobSettings(Object.fromEntries(Object.entries(settings).map(([k, f]) => [k, f.default])))).toEqual(
      DEFAULT_SETTINGS,
    )
  })

  it('reads saved values and falls back to defaults for missing or unknown ones', () => {
    expect(blobSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(blobSettings({ size: 'Small', style: 'Ghost', animation: false, 'needs-you': false })).toEqual({
      size: 'Small',
      animation: false,
      places: { list: true, needsYou: false, grid: true },
    })
    expect(blobSettings({ size: 'Huge', list: 'yes' })).toEqual(DEFAULT_SETTINGS)
  })

  it('shows blobs only in the places turned on; the legend follows the list', () => {
    const settings = blobSettings({ list: false, grid: false })
    expect(showsIn(settings, 'list')).toBe(false)
    expect(showsIn(settings, 'legend')).toBe(false)
    expect(showsIn(settings, 'header')).toBe(false)
    expect(showsIn(settings, 'home')).toBe(false)
    expect(showsIn(settings, 'grid')).toBe(false)
    expect(showsIn(settings, 'needsYou')).toBe(true)
  })

  it('grows with each size and never outgrows a row: 36 px inside on desktop, 43 px on touch', () => {
    const sides = SIZES.map((size) => SIZE_PX[size])
    for (const [smaller, larger] of sides.slice(0, -1).map((side, i) => [side, sides[i + 1]] as const)) {
      expect(larger?.fine ?? 0).toBeGreaterThan(smaller.fine)
      expect(larger?.coarse ?? 0).toBeGreaterThan(smaller.coarse)
    }
    expect(SIZE_PX.Large.fine).toBeLessThanOrEqual(36)
    expect(SIZE_PX.Large.coarse).toBeLessThanOrEqual(43)
  })
})
