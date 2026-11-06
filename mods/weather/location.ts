import type { GeoPoint } from './solar'

/** "52.5, 13.4" as a point on the globe; anything else, empty included, is null. */
export function parseLocation(text: string): GeoPoint | null {
  const parts = text.split(',').map((part) => part.trim())
  if (parts.length !== 2 || parts.some((part) => part === '')) {
    return null
  }
  const [lat, lon] = parts.map(Number)
  if (lat === undefined || lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null
  }
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null
}
