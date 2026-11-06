import { hex, mix, type Palette, type Rgba } from './palette'
import { COLUMN, type Columns, columnAt, seededRandom, type WeatherScene } from './scene'
import { smoothstep } from './weather'

interface Cloud {
  x: number
  /** Bottom edge in CSS pixels. */
  base: number
  w: number
  h: number
  near: boolean
  /** The cloud cover at which this cloud shows, so denser skies show more of them. */
  threshold: number
  seed: number
  sprite: HTMLCanvasElement | null
  key: string
}

interface Layer {
  near: boolean
  spacing: number
  width: readonly [number, number]
  height: readonly [number, number]
  base: readonly [number, number]
  alpha: number
}

/** Far clouds sit higher, smaller, fainter and slower than near ones, for a little depth. */
const LAYERS: readonly Layer[] = [
  { near: false, spacing: 30, width: [20, 44], height: [0.16, 0.24], base: [0.22, 0.46], alpha: 0.6 },
  { near: true, spacing: 44, width: [34, 76], height: [0.26, 0.38], base: [0.44, 0.78], alpha: 0.88 },
]

const MARGIN = 60

const between = (range: readonly [number, number], t: number) => range[0] + (range[1] - range[0]) * t

/** Cloud colours at a column: a lit top and a shaded base, tinted by the time of day. */
function cloudTint(columns: Columns, index: number, palette: Palette): readonly [Rgba, Rgba] {
  const storm = columns.storm[index] ?? 0
  const night = columns.night[index] ?? 0
  const glow = (columns.glow[index] ?? 0) * (1 - storm * 0.6)
  const warm = columns.evening[index] === 1 ? palette.dusk : palette.dawn
  const dayTop = mix(palette.cloud, palette.cloudShade, storm * 0.55)
  const dayBase = mix(palette.cloud, palette.cloudShade, 0.4 + storm * 0.45)
  const nightTop = mix(palette.cloudNight, palette.cloudShade, storm * 0.35)
  const nightBase = mix(palette.cloudNight, palette.cloudShade, 0.3 + storm * 0.4)
  const top = mix(mix(dayTop, nightTop, night), warm, glow * 0.35)
  const base = mix(mix(dayBase, nightBase, night), palette.sunLow, glow * 0.45)
  return [top, base]
}

const quantize = (color: Rgba) =>
  hex([color[0] - (color[0] % 6), color[1] - (color[1] % 6), color[2] - (color[2] % 6), 1])

function renderSprite(cloud: Cloud, top: Rgba, base: Rgba, dpr: number): HTMLCanvasElement {
  const pad = cloud.h * 0.7
  const canvas = cloud.sprite ?? document.createElement('canvas')
  canvas.width = Math.ceil((cloud.w + pad * 2) * dpr)
  canvas.height = Math.ceil((cloud.h + pad * 2) * dpr)
  const ctx = canvas.getContext('2d')
  if (ctx === null) {
    return canvas
  }
  ctx.scale(dpr, dpr)
  const random = seededRandom(cloud.seed)
  const puffs = 3 + Math.floor(cloud.w / (cloud.h * 0.9))
  for (let index = 0; index < puffs; index += 1) {
    const t = (index + 0.5) / puffs
    const r = cloud.h * (0.42 + 0.45 * Math.sin(Math.PI * t)) * (0.85 + 0.3 * random())
    const x = pad + t * cloud.w + (random() - 0.5) * r * 0.5
    const y = pad + cloud.h - r * 0.9 + (random() - 0.5) * 2
    const puff = ctx.createRadialGradient(x, y, 0, x, y, r)
    puff.addColorStop(0, hex(top, 0.95))
    puff.addColorStop(0.5, hex(top, 0.75))
    puff.addColorStop(1, hex(top, 0))
    ctx.fillStyle = puff
    ctx.fillRect(x - r, y - r, r * 2, r * 2)
  }
  ctx.globalCompositeOperation = 'source-in'
  const shade = ctx.createLinearGradient(0, pad * 0.4, 0, pad + cloud.h)
  shade.addColorStop(0, hex(top))
  shade.addColorStop(1, hex(base))
  ctx.fillStyle = shade
  ctx.fillRect(0, 0, cloud.w + pad * 2, cloud.h + pad * 2)
  ctx.globalCompositeOperation = 'destination-out'
  const flat = ctx.createLinearGradient(0, pad + cloud.h * 0.8, 0, pad + cloud.h * 1.3)
  flat.addColorStop(0, hex(base, 0))
  flat.addColorStop(1, hex(base, 1))
  ctx.fillStyle = flat
  ctx.fillRect(0, pad + cloud.h * 0.8, cloud.w + pad * 2, cloud.h + pad)
  return canvas
}

/** Two layers of soft clouds drifting with the wind, shown where the forecast has cloud. */
export class CloudField {
  private clouds: Cloud[] = []
  private width = 0

  layout(scene: WeatherScene): void {
    if (scene.width === this.width && this.clouds.length > 0) {
      return
    }
    this.width = scene.width
    const random = seededRandom(Math.round(scene.width) + 7)
    this.clouds = LAYERS.flatMap((layer) => {
      const count = Math.ceil((scene.width + MARGIN * 2) / layer.spacing)
      return Array.from({ length: count }, (_, index): Cloud => {
        const h = between(layer.height, random()) * scene.horizon
        return {
          x: -MARGIN + (index + random() * 0.8) * layer.spacing,
          base: between(layer.base, random()) * scene.horizon,
          w: between(layer.width, random()),
          h,
          near: layer.near,
          threshold: 0.04 + random() * 0.9,
          seed: Math.floor(random() * 1e9),
          sprite: null,
          key: '',
        }
      })
    })
  }

  /** Moves the clouds with the eastward wind in km/h, wrapping them around the band. */
  drift(seconds: number, wind: number): void {
    const direction = wind < 0 ? -1 : 1
    const speed = Math.min(7, Math.max(0.6, Math.abs(wind) * 0.18))
    const span = this.width + MARGIN * 2
    for (const cloud of this.clouds) {
      cloud.x += direction * speed * (cloud.near ? 1 : 0.55) * seconds
      if (cloud.x > this.width + MARGIN) {
        cloud.x -= span
      } else if (cloud.x < -MARGIN) {
        cloud.x += span
      }
    }
  }

  static visible(columns: Columns): boolean {
    return columns.cover.some((cover) => cover > 0.05)
  }

  draw(ctx: CanvasRenderingContext2D, columns: Columns, palette: Palette, dpr: number): void {
    for (const cloud of this.clouds) {
      const index = columnAt(columns, cloud.x)
      const cover = columns.cover[index] ?? 0
      const shown = smoothstep(cloud.threshold - 0.1, cloud.threshold + 0.1, cover)
      if (shown <= 0.01) {
        continue
      }
      const [top, base] = cloudTint(columns, index, palette)
      const key = quantize(top) + quantize(base)
      if (cloud.sprite === null || cloud.key !== key) {
        cloud.sprite = renderSprite(cloud, top, base, dpr)
        cloud.key = key
      }
      const pad = cloud.h * 0.7
      const layer = cloud.near ? 0.88 : 0.6
      ctx.globalAlpha = shown * layer * (0.85 + 0.15 * (columns.storm[index] ?? 0))
      ctx.drawImage(
        cloud.sprite,
        cloud.x - cloud.w / 2 - pad,
        cloud.base - cloud.h - pad,
        cloud.w + pad * 2,
        cloud.h + pad * 2,
      )
    }
    ctx.globalAlpha = 1
  }

  /** Forgets rendered sprites, as after a theme change or a new pixel ratio. */
  invalidate(): void {
    for (const cloud of this.clouds) {
      cloud.key = ''
    }
  }
}

function offscreen(width: number, height: number, dpr: number) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(width * dpr))
  canvas.height = Math.max(1, Math.ceil(height * dpr))
  const ctx = canvas.getContext('2d')
  ctx?.scale(dpr, dpr)
  return { canvas, ctx }
}

const STOP_EVERY = 6

/** Clears a layer the renderer has sized and returns its context in CSS pixels. */
function prepare(target: HTMLCanvasElement, scene: WeatherScene): CanvasRenderingContext2D | null {
  const ctx = target.getContext('2d')
  const scale = target.width / Math.max(1, scene.width)
  ctx?.setTransform(scale, 0, 0, scale, 0, 0)
  ctx?.clearRect(0, 0, scene.width, scene.height)
  return ctx
}

/** Paints the even grey deck of an overcast sky, following the forecast cover across the band. */
export function paintVeil(target: HTMLCanvasElement, scene: WeatherScene, columns: Columns, palette: Palette) {
  const ctx = prepare(target, scene)
  if (ctx === null || !columns.cover.some((cover) => cover > 0.5)) {
    return
  }
  const across = ctx.createLinearGradient(0, 0, scene.width, 0)
  for (let index = 0; index < columns.count; index += STOP_EVERY) {
    const [top, base] = cloudTint(columns, index, palette)
    const alpha = smoothstep(0.5, 1, columns.cover[index] ?? 0) * (0.5 + 0.35 * (columns.storm[index] ?? 0))
    across.addColorStop(Math.min(1, (index * COLUMN) / scene.width), hex(mix(top, base, 0.55), alpha))
  }
  ctx.fillStyle = across
  ctx.fillRect(0, 0, scene.width, scene.horizon)
  ctx.globalCompositeOperation = 'destination-in'
  const down = ctx.createLinearGradient(0, 0, 0, scene.horizon)
  down.addColorStop(0, hex(palette.fog, 1))
  down.addColorStop(1, hex(palette.fog, 0.7))
  ctx.fillStyle = down
  ctx.fillRect(0, 0, scene.width, scene.horizon)
}

/** Paints a soft haze lying on the horizon wherever visibility drops; false when there is none. */
export function paintFog(target: HTMLCanvasElement, scene: WeatherScene, columns: Columns, palette: Palette) {
  const ctx = prepare(target, scene)
  if (ctx === null || !columns.haze.some((amount) => amount > 0.05)) {
    return false
  }
  const across = ctx.createLinearGradient(0, 0, scene.width, 0)
  for (let index = 0; index < columns.count; index += STOP_EVERY) {
    across.addColorStop(
      Math.min(1, (index * COLUMN) / scene.width),
      hex(palette.fog, (columns.haze[index] ?? 0) * 0.92),
    )
  }
  ctx.fillStyle = across
  ctx.fillRect(0, 0, scene.width, scene.height)
  ctx.globalCompositeOperation = 'destination-in'
  const { horizon, height } = scene
  const down = ctx.createLinearGradient(0, 0, 0, height)
  down.addColorStop(0, hex(palette.fog, 0))
  down.addColorStop((horizon * 0.3) / height, hex(palette.fog, 0.05))
  down.addColorStop((horizon * 0.75) / height, hex(palette.fog, 0.55))
  down.addColorStop(horizon / height, hex(palette.fog, 1))
  down.addColorStop((horizon + (height - horizon) * 0.5) / height, hex(palette.fog, 0.65))
  down.addColorStop(1, hex(palette.fog, 0.2))
  ctx.fillStyle = down
  ctx.fillRect(0, 0, scene.width, scene.height)
  return true
}

interface Wisp {
  x: number
  y: number
  w: number
  h: number
}

/** Slow banks of mist drifting along the horizon inside the fog. */
export class FogWisps {
  private wisps: Wisp[] = []
  private width = 0
  private sprite: HTMLCanvasElement | null = null

  layout(scene: WeatherScene): void {
    if (scene.width === this.width && this.wisps.length > 0) {
      return
    }
    this.width = scene.width
    const random = seededRandom(Math.round(scene.width) + 11)
    const count = Math.ceil((scene.width + MARGIN * 2) / 90)
    this.wisps = Array.from({ length: count }, (_, index) => ({
      x: -MARGIN + (index + random()) * 90,
      y: scene.horizon + (random() - 0.65) * scene.horizon * 0.3,
      w: 70 + random() * 90,
      h: 4 + random() * 5,
    }))
  }

  paint(palette: Palette, dpr: number): void {
    const { canvas, ctx } = offscreen(64, 16, dpr)
    if (ctx !== null) {
      ctx.translate(32, 8)
      ctx.scale(4, 1)
      const soft = ctx.createRadialGradient(0, 0, 0, 0, 0, 8)
      soft.addColorStop(0, hex(palette.fog, 1))
      soft.addColorStop(0.5, hex(palette.fog, 0.55))
      soft.addColorStop(1, hex(palette.fog, 0))
      ctx.fillStyle = soft
      ctx.fillRect(-8, -8, 16, 16)
    }
    this.sprite = canvas
  }

  drift(seconds: number, wind: number): void {
    const speed = (wind < 0 ? -1 : 1) * Math.max(1, Math.abs(wind) * 0.08)
    const span = this.width + MARGIN * 2
    for (const wisp of this.wisps) {
      wisp.x += speed * seconds
      if (wisp.x > this.width + MARGIN) {
        wisp.x -= span
      } else if (wisp.x < -MARGIN) {
        wisp.x += span
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D, columns: Columns): void {
    if (this.sprite === null) {
      return
    }
    for (const wisp of this.wisps) {
      const amount = columns.haze[columnAt(columns, wisp.x)] ?? 0
      if (amount < 0.05) {
        continue
      }
      ctx.globalAlpha = amount * 0.6
      ctx.drawImage(this.sprite, wisp.x - wisp.w / 2, wisp.y - wisp.h / 2, wisp.w, wisp.h)
    }
    ctx.globalAlpha = 1
  }
}
