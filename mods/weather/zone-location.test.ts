import { describe, expect, it } from 'vitest'
import { zoneLocation } from './zone-location'

describe('zoneLocation', () => {
  it('uses the table for known zones and their old names', () => {
    expect(zoneLocation('Asia/Kolkata', 330)).toEqual({ lat: 22.57, lon: 88.36, basis: 'Kolkata' })
    expect(zoneLocation('Asia/Calcutta', 330).basis).toBe('Kolkata')
    expect(zoneLocation('America/New_York', -300).basis).toBe('New York')
  })

  it('falls back to the standard offset at a mid latitude', () => {
    expect(zoneLocation('Asia/Kabul', 270)).toEqual({ lat: 40, lon: 67.5, basis: 'UTC+04:30' })
    expect(zoneLocation('America/Argentina/Mendoza', -180)).toEqual({ lat: -40, lon: -45, basis: 'UTC-03:00' })
    expect(zoneLocation('UTC', 0).basis).toBe('UTC+00:00')
  })
})
