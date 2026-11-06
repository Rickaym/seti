import type { GeoPoint } from './solar'

export interface ZoneLocation extends GeoPoint {
  /** Where the point comes from, for example "Berlin" or "UTC+05:30". */
  basis: string
}

type LatLon = readonly [lat: number, lon: number]

const ZONES: Record<string, LatLon> = {
  'Europe/London': [51.51, -0.13],
  'Europe/Dublin': [53.35, -6.26],
  'Europe/Lisbon': [38.72, -9.14],
  'Europe/Madrid': [40.42, -3.7],
  'Europe/Paris': [48.86, 2.35],
  'Europe/Brussels': [50.85, 4.35],
  'Europe/Amsterdam': [52.37, 4.9],
  'Europe/Berlin': [52.52, 13.4],
  'Europe/Zurich': [47.38, 8.54],
  'Europe/Rome': [41.9, 12.5],
  'Europe/Vienna': [48.21, 16.37],
  'Europe/Prague': [50.08, 14.44],
  'Europe/Warsaw': [52.23, 21.01],
  'Europe/Budapest': [47.5, 19.04],
  'Europe/Copenhagen': [55.68, 12.57],
  'Europe/Oslo': [59.91, 10.75],
  'Europe/Stockholm': [59.33, 18.07],
  'Europe/Helsinki': [60.17, 24.94],
  'Europe/Athens': [37.98, 23.73],
  'Europe/Bucharest': [44.43, 26.1],
  'Europe/Istanbul': [41.01, 28.98],
  'Europe/Kyiv': [50.45, 30.52],
  'Europe/Moscow': [55.76, 37.62],
  'Africa/Casablanca': [33.57, -7.59],
  'Africa/Lagos': [6.52, 3.38],
  'Africa/Cairo': [30.04, 31.24],
  'Africa/Nairobi': [-1.29, 36.82],
  'Africa/Johannesburg': [-26.2, 28.05],
  'Asia/Jerusalem': [31.77, 35.21],
  'Asia/Riyadh': [24.71, 46.68],
  'Asia/Tehran': [35.69, 51.39],
  'Asia/Dubai': [25.2, 55.27],
  'Asia/Karachi': [24.86, 67.01],
  'Asia/Kolkata': [22.57, 88.36],
  'Asia/Colombo': [6.93, 79.86],
  'Asia/Kathmandu': [27.72, 85.32],
  'Asia/Dhaka': [23.81, 90.41],
  'Asia/Yangon': [16.87, 96.2],
  'Asia/Bangkok': [13.76, 100.5],
  'Asia/Ho_Chi_Minh': [10.82, 106.63],
  'Asia/Jakarta': [-6.21, 106.85],
  'Asia/Kuala_Lumpur': [3.14, 101.69],
  'Asia/Singapore': [1.35, 103.82],
  'Asia/Manila': [14.6, 120.98],
  'Asia/Hong_Kong': [22.32, 114.17],
  'Asia/Shanghai': [31.23, 121.47],
  'Asia/Taipei': [25.03, 121.57],
  'Asia/Seoul': [37.57, 126.98],
  'Asia/Tokyo': [35.68, 139.69],
  'Australia/Perth': [-31.95, 115.86],
  'Australia/Adelaide': [-34.93, 138.6],
  'Australia/Brisbane': [-27.47, 153.03],
  'Australia/Melbourne': [-37.81, 144.96],
  'Australia/Sydney': [-33.87, 151.21],
  'Pacific/Auckland': [-36.85, 174.76],
  'Pacific/Honolulu': [21.31, -157.86],
  'America/Anchorage': [61.22, -149.9],
  'America/Vancouver': [49.28, -123.12],
  'America/Los_Angeles': [34.05, -118.24],
  'America/Phoenix': [33.45, -112.07],
  'America/Denver': [39.74, -104.99],
  'America/Chicago': [41.88, -87.63],
  'America/Mexico_City': [19.43, -99.13],
  'America/Toronto': [43.65, -79.38],
  'America/New_York': [40.71, -74.01],
  'America/Halifax': [44.65, -63.57],
  'America/Bogota': [4.71, -74.07],
  'America/Lima': [-12.05, -77.04],
  'America/Santiago': [-33.45, -70.67],
  'America/Sao_Paulo': [-23.55, -46.63],
  'America/Argentina/Buenos_Aires': [-34.6, -58.38],
}

/** Older names that browsers still report for some zones. */
const ALIASES: Record<string, string> = {
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Europe/Kiev': 'Europe/Kyiv',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
}

const MID_LATITUDE = 40
const SOUTHERN_REGIONS = ['Australia/', 'Antarctica/', 'America/Argentina/']

function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  const hours = String(Math.floor(abs / 60)).padStart(2, '0')
  return `UTC${sign}${hours}:${String(abs % 60).padStart(2, '0')}`
}

/** A city in an IANA zone, else the standard offset (minutes east) at a mid latitude. */
export function zoneLocation(reported: string, standardOffsetMinutes: number): ZoneLocation {
  const zone = ALIASES[reported] ?? reported
  const known = ZONES[zone]
  if (known) {
    const city = zone.slice(zone.lastIndexOf('/') + 1).replaceAll('_', ' ')
    return { lat: known[0], lon: known[1], basis: city }
  }
  const southern = SOUTHERN_REGIONS.some((region) => zone.startsWith(region))
  return {
    lat: southern ? -MID_LATITUDE : MID_LATITUDE,
    lon: standardOffsetMinutes / 4,
    basis: offsetLabel(standardOffsetMinutes),
  }
}
