import { readFileSync, writeFileSync } from 'node:fs'

// Draws docs/banner-*.svg as a slim header daylight band on a spring morning, using theme tokens.

/** @typedef {{ l: number, c: number, h: number, alpha: number }} Oklch */
/** @typedef {Record<string, Oklch>} Palette */
/** @typedef {'night' | 'twilight' | 'dawn' | 'day' | 'noon' | 'dusk'} Sky */
/** @typedef {{ offset: number, sky: Sky }} SkyStop */

const THEME = 'ui/src/components/theme/themes/default.css'
const WIDTH = 1280
const HEIGHT = 96
const RADIUS = 8
const DETAIL = { margin: 6, tick: 4, majorTick: 6, pool: 70, glow: 20, sun: 6, stars: 90 }
const FRAME = { top: 0.14, horizon: 0.66, bottom: 0.96 }
const HORIZON = Math.round(FRAME.horizon * HEIGHT) + 0.5

const LAT = 48
const DECLINATION = 15
const SOLAR_NOON = 13.3
const NOW = 10.7
const PEAK = Math.min(90, 90 - LAT + 23.44)
const ALTITUDE = { nautical: -12, civil: -6, horizon: -0.833, golden: 6 }

const WORDMARK = {
  size: 40,
  tracking: 0.3,
  x: 40,
  baseline: 52,
  glyphs: [
    'M302 10Q228 10 174 -15Q120 -40 91 -86Q61 -132 61 -194H177Q177 -147 211 -120Q245 -93 304 -93Q359 -93 391 -119' +
      'Q423 -146 423 -193Q423 -232 401 -260Q379 -289 338 -299L250 -324Q167 -347 122 -403Q77 -460 77 -538Q77 -600 ' +
      '104 -645Q132 -690 183 -715Q233 -741 302 -741Q406 -741 467 -686Q528 -632 529 -541H412Q412 -586 383 -612Q354 ' +
      '-638 301 -638Q250 -638 221 -614Q193 -589 193 -546Q193 -506 215 -478Q236 -450 276 -438L367 -412Q450 -390 495 ' +
      '-334Q539 -278 539 -197Q539 -135 510 -89Q480 -42 427 -16Q374 10 302 10Z',
    'M91 0V-730H524V-628H206V-429H489V-327H206V-102H524V0Z',
    'M242 0V-623H48V-731H552V-623H358V0Z',
    'M94 0V-103H241V-627H94V-730H506V-627H359V-103H506V0Z',
  ],
}

const RAD = Math.PI / 180
const GOLDEN_RATIO = 0.618_033_988_75

/** @param {number} value */
const clamp = (value) => Math.max(0, Math.min(1, value))

/** @param {number} value */
const fixed = (value) => value.toFixed(1)

/** @param {number} hour */
function altitude(hour) {
  const lat = LAT * RAD
  const decl = DECLINATION * RAD
  const angle = (hour - SOLAR_NOON) * 15 * RAD
  return Math.asin(Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(angle)) / RAD
}

/** @param {number} degrees */
function crossing(degrees) {
  const lat = LAT * RAD
  const decl = DECLINATION * RAD
  const cos = (Math.sin(degrees * RAD) - Math.sin(lat) * Math.sin(decl)) / (Math.cos(lat) * Math.cos(decl))
  const hours = Math.acos(cos) / RAD / 15
  return { rise: (SOLAR_NOON - hours) / 24, set: (SOLAR_NOON + hours) / 24 }
}

/**
 * @param {number} degrees
 * @returns {Sky}
 */
function skyAt(degrees) {
  if (degrees >= ALTITUDE.golden) {
    return 'day'
  }
  if (degrees >= ALTITUDE.horizon) {
    return 'dusk'
  }
  return degrees >= ALTITUDE.civil ? 'twilight' : 'night'
}

/** @returns {SkyStop[]} */
function skyStops() {
  /** @type {{ altitude: number, morning: Sky, evening: Sky }[]} */
  const phases = [
    { altitude: ALTITUDE.nautical, morning: 'night', evening: 'night' },
    { altitude: ALTITUDE.civil, morning: 'twilight', evening: 'twilight' },
    { altitude: ALTITUDE.horizon, morning: 'dawn', evening: 'dusk' },
    { altitude: ALTITUDE.golden, morning: 'day', evening: 'day' },
  ]
  /** @type {SkyStop[]} */
  const stops = [
    { offset: 0, sky: skyAt(altitude(0)) },
    { offset: SOLAR_NOON / 24, sky: 'noon' },
    { offset: 1, sky: skyAt(altitude(24)) },
  ]
  for (const phase of phases) {
    const times = crossing(phase.altitude)
    stops.push({ offset: times.rise, sky: phase.morning }, { offset: times.set, sky: phase.evening })
  }
  return stops.sort((a, b) => a.offset - b.offset)
}

/**
 * The `--daylight-*` and foreground tokens of one CSS block, keyed without the prefix.
 * @param {string} css
 * @param {string} selector
 * @returns {Palette}
 */
function palette(css, selector) {
  const start = css.indexOf(`\n${selector} {`)
  const block = css.slice(start, css.indexOf('}', start))
  /** @type {Palette} */
  const tokens = {}
  for (const match of block.matchAll(/--(daylight-[a-z-]+|foreground):\s*oklch\(([^)]+)\)/g)) {
    const [, name = '', body = ''] = match
    const [color = '', alpha = '100%'] = body.split('/').map((part) => part.trim())
    const [l = 0, c = 0, h = 0] = color.split(/\s+/).map(Number)
    tokens[name.replace(/^daylight-/, '')] = { l, c, h, alpha: Number.parseFloat(alpha) / 100 }
  }
  return tokens
}

/**
 * @param {Palette} tokens
 * @param {string} name
 */
function token(tokens, name) {
  const value = tokens[name]
  if (!value) {
    throw new Error(`Missing token --daylight-${name} in ${THEME}`)
  }
  return value
}

/** @param {Oklch} color */
function toLab({ l, c, h }) {
  return { l, a: c * Math.cos(h * RAD), b: c * Math.sin(h * RAD) }
}

/** @param {{ l: number, a: number, b: number }} lab */
function hex({ l, a, b }) {
  const lms = [l + 0.396_337_777_4 * a + 0.215_803_757_3 * b, l - 0.105_561_345_8 * a - 0.063_854_172_8 * b]
  lms.push(l - 0.089_484_177_5 * a - 1.291_485_548 * b)
  const [p = 0, q = 0, s = 0] = lms.map((value) => value ** 3)
  const linear = [
    4.076_741_662_1 * p - 3.307_711_591_3 * q + 0.230_969_929_2 * s,
    -1.268_438_004_6 * p + 2.609_757_401_1 * q - 0.341_319_396_5 * s,
    -0.004_196_086_3 * p - 0.703_418_614_7 * q + 1.707_614_701 * s,
  ]
  const encoded = linear.map((value) => {
    const v = clamp(value)
    const srgb = v <= 0.003_130_8 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055
    return Math.round(srgb * 255)
      .toString(16)
      .padStart(2, '0')
  })
  return `#${encoded.join('')}`
}

/**
 * Mixes two colours in oklab, `share` of the way from `from` to `to`.
 * @param {Oklch} from
 * @param {Oklch} to
 * @param {number} share
 */
function mix(from, to, share) {
  const a = toLab(from)
  const b = toLab(to)
  return hex({ l: a.l + (b.l - a.l) * share, a: a.a + (b.a - a.a) * share, b: a.b + (b.b - a.b) * share })
}

/**
 * @param {Oklch} color
 * @param {number} offset
 */
const stop = (color, offset) =>
  `<stop offset="${offset.toFixed(4)}" stop-color="${hex(toLab(color))}" stop-opacity="${color.alpha.toFixed(2)}"/>`

/**
 * The CSS gradient interpolates in oklab and SVG in sRGB, so each span gets extra stops.
 * @param {Palette} tokens
 */
function skyGradient(tokens) {
  const stops = skyStops()
  return stops
    .flatMap((current, index) => {
      const next = stops[index + 1]
      const from = token(tokens, current.sky)
      if (!next) {
        return [stop(from, current.offset)]
      }
      const to = token(tokens, next.sky)
      const steps = Math.max(1, Math.ceil((next.offset - current.offset) * 60))
      return Array.from({ length: steps }, (_, step) => {
        const share = step / steps
        const offset = current.offset + (next.offset - current.offset) * share
        return `<stop offset="${offset.toFixed(4)}" stop-color="${mix(from, to, share)}"/>`
      })
    })
    .join('')
}

/** @param {number} degrees */
const arcY = (degrees) => {
  const share = Math.max(-1, Math.min(1, degrees / PEAK))
  const span = share >= 0 ? FRAME.horizon - FRAME.top : FRAME.bottom - FRAME.horizon
  return (FRAME.horizon - share * span) * HEIGHT
}

/** @param {number} hour */
const xAt = (hour) => (hour / 24) * WIDTH

/**
 * @param {number} x
 * @param {number} y
 */
function behindWordmark(x, y) {
  const margin = DETAIL.margin
  const right = WORDMARK.x + WORDMARK.size * (0.6 + WORDMARK.tracking) * 3 + WORDMARK.size * 0.6
  const top = WORDMARK.baseline - WORDMARK.size * 0.73
  return x > WORDMARK.x - margin && x < right + margin && y > top - margin && y < WORDMARK.baseline + margin
}

/** @param {Palette} tokens */
function stars(tokens) {
  const color = hex(toLab(token(tokens, 'star')))
  const circles = Array.from({ length: DETAIL.stars }, (_, index) => {
    const n = index + 1
    const x = (n * GOLDEN_RATIO) % 1
    const lift = 0.2 + 0.75 * ((n * 0.754_877_666) % 1)
    const weight = 0.35 + 0.65 * ((n * 0.569_840_29) % 1) ** 2
    const light = clamp((ALTITUDE.civil - altitude(x * 24)) / (ALTITUDE.civil - ALTITUDE.nautical))
    const opacity = light * weight
    const cy = HORIZON - lift * (HORIZON - DETAIL.margin)
    return opacity < 0.05 || behindWordmark(x * WIDTH, cy)
      ? ''
      : `<circle cx="${fixed(x * WIDTH)}" cy="${fixed(cy)}" r="${(0.7 + 0.8 * weight).toFixed(2)}" opacity="${opacity.toFixed(2)}"/>`
  })
  return `<g fill="${color}">${circles.join('')}</g>`
}

/** @param {Palette} tokens */
function horizon(tokens) {
  const line = token(tokens, 'line')
  const ticks = Array.from({ length: 23 }, (_, index) => {
    const x = Math.round(xAt(index + 1)) + 0.5
    const length = (index + 1) % 6 === 0 ? DETAIL.majorTick : DETAIL.tick
    return `<line x1="${fixed(x)}" x2="${fixed(x)}" y1="${fixed(HORIZON)}" y2="${fixed(HORIZON + length)}"/>`
  })
  const attributes = `stroke="${hex(toLab(line))}" stroke-opacity="${line.alpha.toFixed(2)}" shape-rendering="crispEdges"`
  return `<g ${attributes}><line x1="0" x2="${String(WIDTH)}" y1="${fixed(HORIZON)}" y2="${fixed(HORIZON)}"/>${ticks.join('')}</g>`
}

/** @param {Palette} tokens */
function sunPath(tokens) {
  const points = Array.from({ length: 289 }, (_, index) => {
    const hour = (index / 288) * 24
    return `${fixed(xAt(hour))},${fixed(arcY(altitude(hour)))}`
  }).join(' ')
  const path = token(tokens, 'path')
  const past = token(tokens, 'path-past')
  return (
    `<polyline points="${points}" fill="none" stroke="${hex(toLab(path))}" stroke-opacity="${path.alpha.toFixed(2)}" ` +
    `stroke-width="1.5" stroke-dasharray="3 6"/>` +
    `<polyline points="${points}" fill="none" stroke="${hex(toLab(past))}" stroke-opacity="${past.alpha.toFixed(2)}" ` +
    `stroke-width="2" clip-path="url(#past)"/>`
  )
}

/** @param {Palette} tokens */
function wordmark(tokens) {
  const scale = WORDMARK.size / 1000
  const advance = WORDMARK.size * (0.6 + WORDMARK.tracking)
  const glyphs = WORDMARK.glyphs.map((d, index) => {
    const x = WORDMARK.x + index * advance
    return `<path transform="translate(${fixed(x)} ${String(WORDMARK.baseline)}) scale(${String(scale)})" d="${d}"/>`
  })
  return `<g fill="${hex(toLab(token(tokens, 'foreground')))}">${glyphs.join('')}</g>`
}

/** @param {Palette} tokens */
function sun(tokens) {
  const height = altitude(NOW)
  const color = mix(token(tokens, 'sun-low'), token(tokens, 'sun'), clamp(height / 20))
  const x = fixed(xAt(NOW))
  const y = fixed(arcY(height))
  const gradients =
    `<radialGradient id="pool"><stop offset="0" stop-color="${color}" stop-opacity="0.3"/>` +
    `<stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="glow"><stop offset="0" stop-color="${color}" stop-opacity="0.75"/>` +
    `<stop offset="0.3" stop-color="${color}" stop-opacity="0.28"/>` +
    `<stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`
  return {
    gradients,
    pool: `<ellipse cx="${x}" cy="${y}" rx="${String(DETAIL.pool * 2)}" ry="${String(DETAIL.pool)}" fill="url(#pool)"/>`,
    body: `<circle cx="${x}" cy="${y}" r="${String(DETAIL.glow)}" fill="url(#glow)"/><circle cx="${x}" cy="${y}" r="${String(DETAIL.sun)}" fill="${color}"/>`,
  }
}

/**
 * @param {Palette} tokens
 * @param {string} name
 * @param {string} id
 */
function vertical(tokens, name, id) {
  const [from, to] = name.split(':')
  return (
    `<linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1">` +
    `${stop(token(tokens, from ?? ''), 0)}${stop(token(tokens, to ?? ''), 1)}</linearGradient>`
  )
}

/** @param {Palette} tokens */
function banner(tokens) {
  const light = sun(tokens)
  const size = `width="${String(WIDTH)}" height="${String(HEIGHT)}"`
  const line = token(tokens, 'line')
  const defs = [
    `<linearGradient id="sky" x1="0" x2="1" y1="0" y2="0">${skyGradient(tokens)}</linearGradient>`,
    vertical(tokens, 'zenith:haze', 'air'),
    vertical(tokens, 'ground-near:ground-far', 'ground'),
    light.gradients,
    `<clipPath id="card"><rect ${size} rx="${String(RADIUS)}"/></clipPath>`,
    `<clipPath id="past"><rect width="${fixed(xAt(NOW))}" height="${String(HEIGHT)}"/></clipPath>`,
  ]
  const scene = [
    `<rect ${size} fill="url(#sky)"/>`,
    `<rect width="${String(WIDTH)}" height="${fixed(HORIZON)}" fill="url(#air)"/>`,
    `<rect y="${fixed(HORIZON)}" width="${String(WIDTH)}" height="${fixed(HEIGHT - HORIZON)}" fill="url(#ground)"/>`,
    light.pool,
    stars(tokens),
    horizon(tokens),
    sunPath(tokens),
    wordmark(tokens),
    light.body,
  ]
  const border =
    `<rect x="0.5" y="0.5" width="${String(WIDTH - 1)}" height="${String(HEIGHT - 1)}" rx="${String(RADIUS - 0.5)}" ` +
    `fill="none" stroke="${hex(toLab(line))}" stroke-opacity="${line.alpha.toFixed(2)}"/>`
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" ${size} viewBox="0 0 ${String(WIDTH)} ${String(HEIGHT)}" role="img" aria-label="Seti">`,
    '<title>Seti</title>',
    `<defs>${defs.join('')}</defs>`,
    `<g clip-path="url(#card)">${scene.join('')}</g>`,
    border,
    '</svg>',
    '',
  ].join('\n')
}

const source = readFileSync(new URL(`../${THEME}`, import.meta.url), 'utf8')
// The leading newline lets palette() match a selector on the first line.
const css = `\n${source}`
for (const [theme, selector] of [
  ['light', ':root'],
  ['dark', '.dark'],
]) {
  const file = new URL(`../docs/banner-${theme ?? ''}.svg`, import.meta.url)
  writeFileSync(file, banner(palette(css, selector ?? '')))
  console.log(`Wrote ${file.pathname}`)
}
