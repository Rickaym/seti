import { useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { WeatherSky } from './WeatherSky'
import { type Daylight, daylight, type SkyStop } from './daylight'
import { useMinute, usePrefersReducedMotion } from './hooks'
import { type MoonState, moonLitPath, moonState } from './moon'
import type { SceneStar, WeatherScene } from './scene'
import { type ArcFrame, altitudeAt, arcY, peakAltitude, type SunSample, starField, starlight, sunPath } from './sky'
import { type GeoPoint, solarNoon, sunAltitude } from './solar'
import { type Forecasts, useWeather } from './useWeather'
import { clearness, type TemperatureUnit, veiling, type WeatherField, weatherField, weatherText } from './weather'
import { type ZoneLocation, zoneLocation } from './zone-location'

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone
const STEPS = 144
const FRAME: ArcFrame = { top: 0.14, horizon: 0.66, bottom: 0.96 }
const STARS = starField(60)
const MOON_RADIUS = 4
const SUN_RADIUS = 3.5
const LABEL_MIN_WIDTH = 480
const LABEL_WIDTH = 44
const FADE = 'linear-gradient(to right, transparent, black 40px, black calc(100% - 40px), transparent)'

interface Size {
  width: number
  height: number
}

interface Sky {
  start: number
  end: number
  day: Daylight
  path: SunSample[]
  hours: { hour: number; offset: number }[]
  peak: number
  location: ZoneLocation
  /** Day offset of solar noon. */
  noon: number
}

/** Pixel positions in the band for a day offset and a sun altitude. */
interface Plot {
  width: number
  height: number
  x: (offset: number) => number
  y: (altitude: number) => number
  horizon: number
}

const clamp = (value: number) => Math.max(0, Math.min(1, value))

const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

function standardOffsetMinutes(year: number): number {
  return Math.min(-new Date(year, 0, 1).getTimezoneOffset(), -new Date(year, 6, 1).getTimezoneOffset())
}

function skyGradient(stops: readonly SkyStop[]): string {
  const parts = stops.map((stop) => `var(--daylight-${stop.sky}) ${(stop.offset * 100).toFixed(2)}%`)
  return `linear-gradient(in oklab to right, ${parts.join(', ')})`
}

function sunText(day: Daylight): string {
  if (day.sunrise !== null && day.sunset !== null) {
    return `Sunrise ${clock(day.sunrise)}, sunset ${clock(day.sunset)}`
  }
  return day.polar === 'day' ? 'The sun does not set today' : 'The sun does not rise today'
}

function skyOf(start: number, end: number, chosen: GeoPoint | null): Sky {
  const first = new Date(start)
  const location =
    chosen === null ? zoneLocation(ZONE, standardOffsetMinutes(first.getFullYear())) : { ...chosen, basis: 'Location' }
  const hours = Array.from({ length: 23 }, (_, index) => {
    const hour = index + 1
    const at = new Date(first.getFullYear(), first.getMonth(), first.getDate(), hour).getTime()
    return { hour, offset: (at - start) / (end - start) }
  })
  return {
    start,
    end,
    day: daylight(start, end, location),
    path: sunPath(start, end, location, STEPS),
    hours,
    peak: peakAltitude(location.lat),
    location,
    noon: (solarNoon((start + end) / 2, location) - start) / (end - start),
  }
}

function useSky(now: number, chosen: GeoPoint | null): Sky {
  const today = new Date(now)
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime()
  const lat = chosen?.lat ?? null
  const lon = chosen?.lon ?? null
  return useMemo(() => skyOf(start, end, lat === null || lon === null ? null : { lat, lon }), [start, end, lat, lon])
}

function useSize(ref: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) {
      return undefined
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
      }
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [ref])
  return size
}

/** The sun's colour by altitude, greyed toward the clouds as much as they veil it. */
function sunColor(altitude: number, veil: number): string {
  const warmth = Math.round(clamp(altitude / 20) * 100)
  const sun = `color-mix(in oklch, var(--daylight-sun) ${String(warmth)}%, var(--daylight-sun-low))`
  const clear = Math.round(100 - veil * 55)
  return veil > 0 ? `color-mix(in oklab, ${sun} ${String(clear)}%, var(--weather-cloud-shade))` : sun
}

/** Stars where they stand in the band, dimmed by twilight and by any cloud or fog in front. */
function visibleStars(sky: Sky, plot: Plot, field: WeatherField | null): SceneStar[] {
  return STARS.flatMap((star) => {
    const clear = field === null ? 1 : clearness(field.at(star.x))
    const opacity = starlight(altitudeAt(sky.path, star.x)) * star.weight * clear
    return opacity < 0.05
      ? []
      : [{ x: plot.x(star.x), y: plot.horizon - star.lift * (plot.horizon - 3), opacity, weight: star.weight }]
  })
}

interface SceneryProps {
  sky: Sky
  plot: Plot
  offset: number
  sun: number
  stars: readonly SceneStar[]
  veil: number
}

/** Stars, the horizon with hour ticks and the sun's path, faded out at both ends. */
function Scenery({ sky, plot, offset, sun, stars, veil }: SceneryProps) {
  const pastId = useId()
  const poolId = useId()
  const { width, height, x, y, horizon } = plot
  const points = sky.path.map((sample) => `${x(sample.offset).toFixed(1)},${y(sample.altitude).toFixed(1)}`).join(' ')
  const now = x(offset)
  const labels = [
    { at: sky.day.sunrise, anchor: 'end', shift: -5 },
    { at: sky.day.sunset, anchor: 'start', shift: 5 },
  ] as const
  const labelled = labels.flatMap(({ at, anchor, shift }) => {
    const left = at === null ? 0 : x((at - sky.start) / (sky.end - sky.start)) + shift
    const clear =
      shift < 0 ? now < left - LABEL_WIDTH - 8 || now > left + 8 : now < left - 8 || now > left + LABEL_WIDTH + 8
    return at !== null && clear && width >= LABEL_MIN_WIDTH ? [{ at, anchor, left }] : []
  })
  const color = sunColor(sun, veil)
  return (
    <svg aria-hidden className="absolute inset-0" width={width} height={height}>
      <defs>
        <radialGradient id={poolId}>
          <stop offset="0%" style={{ stopColor: color, stopOpacity: 0.3 }} />
          <stop offset="100%" style={{ stopColor: color, stopOpacity: 0 }} />
        </radialGradient>
        <clipPath id={pastId}>
          <rect width={now} height={height} />
        </clipPath>
      </defs>
      <ellipse
        cx={now}
        cy={y(sun)}
        rx={72}
        ry={36}
        fill={`url(#${poolId})`}
        opacity={clamp((sun + 4) / 10) * (1 - veil * 0.8)}
      />
      <g fill="var(--daylight-star)">
        {stars.map((star) => (
          <circle key={star.x} cx={star.x} cy={star.y} r={0.45 + 0.45 * star.weight} opacity={star.opacity} />
        ))}
      </g>
      <g stroke="var(--daylight-line)" shapeRendering="crispEdges">
        <line x2={width} y1={horizon} y2={horizon} />
        {sky.hours.map(({ hour, offset: at }) => (
          <line
            key={hour}
            x1={Math.round(x(at)) + 0.5}
            x2={Math.round(x(at)) + 0.5}
            y1={horizon}
            y2={horizon + (hour % 6 === 0 ? 4 : 2)}
          />
        ))}
      </g>
      <polyline points={points} fill="none" stroke="var(--daylight-path)" strokeDasharray="1.5 3" />
      <polyline
        points={points}
        fill="none"
        stroke="var(--daylight-path-past)"
        strokeWidth={1.25}
        clipPath={`url(#${pastId})`}
      />
      {labelled.map(({ at, anchor, left }) => (
        <text key={anchor} x={left} y={horizon + 12} textAnchor={anchor} className="fill-muted-foreground text-2xs">
          {clock(at)}
        </text>
      ))}
    </svg>
  )
}

interface BodiesProps {
  plot: Plot
  offset: number
  sun: number
  moon: MoonState
  southern: boolean
  veil: number
}

/** The sun and moon where they stand now, drawn over the fade so they stay clear at midnight. */
function Bodies({ plot, offset, sun, moon, southern, veil }: BodiesProps) {
  const glowId = useId()
  const { width, height, x, y } = plot
  const color = sunColor(sun, veil)
  const up = clamp((sun + 1) / 4)
  const at = x(offset).toFixed(1)
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0 overflow-visible" width={width} height={height}>
      <defs>
        <radialGradient id={glowId}>
          <stop offset="0%" style={{ stopColor: color, stopOpacity: 0.75 }} />
          <stop offset="30%" style={{ stopColor: color, stopOpacity: 0.28 }} />
          <stop offset="100%" style={{ stopColor: color, stopOpacity: 0 }} />
        </radialGradient>
      </defs>
      {moon.altitude > 0 && (
        <g
          transform={`translate(${at} ${y(moon.altitude).toFixed(1)})${southern ? ' scale(-1 1)' : ''}`}
          opacity={(sun > 0 ? 0.6 : 1) * (1 - veil * 0.55)}
        >
          <circle
            r={MOON_RADIUS}
            className="fill-(--daylight-moon-shade) stroke-(--daylight-moon-rim)"
            strokeWidth={0.75}
          />
          <path d={moonLitPath(moon.phase, MOON_RADIUS)} fill="var(--daylight-moon)" />
        </g>
      )}
      <g transform={`translate(${at} ${y(sun).toFixed(1)})`}>
        {up > 0 && <circle r={14} fill={`url(#${glowId})`} opacity={up * (1 - veil * 0.8)} />}
        {up > 0 ? (
          <circle r={SUN_RADIUS} style={{ fill: color }} />
        ) : (
          <circle r={SUN_RADIUS - 0.5} fill="none" stroke="var(--daylight-path-past)" strokeWidth={1} />
        )}
      </g>
    </svg>
  )
}

function usePlot(sky: Sky, width: number, height: number): Plot {
  return useMemo(
    () => ({
      width,
      height,
      x: (at: number) => at * width,
      y: (altitude: number) => arcY(altitude, sky.peak, FRAME) * height,
      horizon: Math.round(FRAME.horizon * height) + 0.5,
    }),
    [sky, width, height],
  )
}

export interface BandSettings {
  /** Draws the weather and looks it up. */
  weather: boolean
  units: TemperatureUnit
  /** Where the sun and weather are, or null for the time zone's city. */
  location: GeoPoint | null
}

/** Today's sky from midnight to midnight: the sun's arc, the moon, the weather and the time now. */
export function DaylightBand({ forecasts, settings }: { forecasts: Forecasts; settings: BandSettings }) {
  const now = useMinute()
  const ref = useRef<HTMLDivElement>(null)
  const { width, height } = useSize(ref)
  const sky = useSky(now, settings.location)
  const { location } = sky
  const offset = (now - sky.start) / (sky.end - sky.start)
  const sun = sunAltitude(now, location)
  const moon = moonState(now, location)
  const time = clock(now)
  const sunLine = sunText(sky.day)
  const plot = usePlot(sky, width, height)
  const reducedMotion = usePrefersReducedMotion()
  const report = useWeather(forecasts, location, now, settings.weather)
  const field = useMemo(() => (report ? weatherField(report, sky.start, sky.end) : null), [report, sky])
  const stars = useMemo(() => visibleStars(sky, plot, field), [sky, plot, field])
  const scene = useMemo<WeatherScene | null>(
    () =>
      field === null || plot.width === 0
        ? null
        : {
            width: plot.width,
            height: plot.height,
            horizon: plot.horizon,
            field,
            altitude: (at) => altitudeAt(sky.path, at),
            noon: sky.noon,
            stars,
            reducedMotion,
          },
    [field, plot, sky, stars, reducedMotion],
  )
  const veil = field === null ? 0 : veiling(field.at(offset))
  const weatherLine = field === null ? null : weatherText(field.current, settings.units)
  const label = [`Daylight, ${time}`, sunLine, ...(weatherLine === null ? [] : [weatherLine])].join('. ')

  return (
    <div ref={ref} role="img" aria-label={label} className="relative min-w-0 flex-1 self-stretch select-none">
      <div className="absolute inset-0 overflow-hidden" style={{ maskImage: FADE }}>
        <div className="absolute inset-0" style={{ backgroundImage: skyGradient(sky.day.stops) }} />
        <div
          className="absolute inset-x-0 top-0 bg-linear-to-b from-(--daylight-zenith) to-(--daylight-haze)"
          style={{ height: plot.horizon }}
        />
        <div
          className="absolute inset-x-0 bottom-0 bg-linear-to-b from-(--daylight-ground-near) to-(--daylight-ground-far)"
          style={{ top: plot.horizon }}
        />
        {width > 0 && <Scenery sky={sky} plot={plot} offset={offset} sun={sun} stars={stars} veil={veil} />}
        {scene !== null && <WeatherSky scene={scene} />}
      </div>
      {width > 0 && (
        <Bodies plot={plot} offset={offset} sun={sun} moon={moon} southern={location.lat < 0} veil={veil} />
      )}
    </div>
  )
}
