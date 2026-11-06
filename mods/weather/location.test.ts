import { describe, expect, it } from 'vitest'
import { parseLocation } from './location'

describe('parseLocation', () => {
  it('reads a latitude and longitude', () => {
    expect(parseLocation('52.5, 13.4')).toEqual({ lat: 52.5, lon: 13.4 })
    expect(parseLocation(' -33.87,151.21 ')).toEqual({ lat: -33.87, lon: 151.21 })
  })

  it('reads anything else, empty included, as no location', () => {
    expect(parseLocation('')).toBeNull()
    expect(parseLocation('Berlin')).toBeNull()
    expect(parseLocation('52.5')).toBeNull()
    expect(parseLocation('52.5, ')).toBeNull()
    expect(parseLocation('91, 0')).toBeNull()
    expect(parseLocation('0, 181')).toBeNull()
    expect(parseLocation('1, 2, 3')).toBeNull()
  })
})
