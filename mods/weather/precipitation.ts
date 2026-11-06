import { hex, type Palette } from './palette'
import { COLUMN, type Columns, type Sampler, samplerOf } from './scene'
import { type Precipitation, smoothstep } from './weather'

interface Drop {
  x: number
  y: number
  /** Fall speed in CSS pixels per second. */
  speed: number
  kind: Precipitation
  /** Sleet falls as a mix of streaks and ice pellets. */
  pellet: boolean
  size: number
  alpha: number
  phase: number
}

interface Splash {
  x: number
  age: number
}

interface Motion {
  speed: readonly [number, number]
  /** Seconds of fall each streak spans, its motion blur. */
  streak: number
  width: number
  alpha: number
}

const MOTION: Record<Precipitation, Motion> = {
  drizzle: { speed: [38, 52], streak: 0.05, width: 0.5, alpha: 0.42 },
  rain: { speed: [95, 125], streak: 0.045, width: 0.55, alpha: 0.5 },
  heavy: { speed: [125, 165], streak: 0.05, width: 0.6, alpha: 0.55 },
  snow: { speed: [7, 12], streak: 0, width: 0, alpha: 0.95 },
  sleet: { speed: [85, 110], streak: 0.035, width: 0.55, alpha: 0.5 },
}

const PELLET_SPEED: readonly [number, number] = [60, 80]
const SPLASH_SECONDS = 0.3
const BUCKETS = [0.55, 0.75, 1] as const
const KINDS: readonly Precipitation[] = ['drizzle', 'rain', 'heavy', 'sleet']

const between = (range: readonly [number, number], t: number) => range[0] + (range[1] - range[0]) * t

/** How far rain leans per pixel of fall under an eastward wind in km/h. */
const slantOf = (wind: number) => Math.max(-0.55, Math.min(0.55, wind / 45))

const isFlake = (drop: Drop) => drop.kind === 'snow' || drop.pellet

/** Rain, drizzle, sleet and snow falling from the clouds to the horizon, densest where it pours. */
export class Rainfall {
  private readonly drops: Drop[] = []
  private splashes: Splash[] = []
  private sampler: Sampler = samplerOf(new Float32Array(0))
  private kinds: (Precipitation | null)[] = []
  private clock = 0

  private readonly random: () => number

  constructor(random: () => number) {
    this.random = random
  }

  /** Matches the number and spread of drops to the columns; new drops start anywhere in the air. */
  configure(columns: Columns, horizon: number): void {
    this.sampler = samplerOf(columns.density)
    this.kinds = columns.kind
    const target = Math.round(this.sampler.total * COLUMN)
    if (this.drops.length > target) {
      this.drops.length = target
    }
    while (this.drops.length < target) {
      this.drops.push(this.spawn(this.random() * horizon))
    }
    for (const drop of this.drops) {
      this.respawnIfStale(drop)
    }
  }

  get active(): boolean {
    return this.drops.length > 0
  }

  private respawnIfStale(drop: Drop): void {
    const index = Math.round(drop.x / COLUMN)
    if (this.kinds[index] !== drop.kind) {
      Object.assign(drop, this.spawn(drop.y))
    }
  }

  private spawn(y: number): Drop {
    const index = this.sampler.pick(this.random())
    const kind = this.kinds[index] ?? 'rain'
    const pellet = kind === 'sleet' && this.random() < 0.45
    const speed = between(pellet ? PELLET_SPEED : MOTION[kind].speed, this.random())
    return {
      x: (index + this.random() - 0.5) * COLUMN,
      y,
      speed,
      kind,
      pellet,
      size: kind === 'snow' ? 0.55 + this.random() * 0.9 : 0.6,
      alpha: BUCKETS[Math.floor(this.random() * BUCKETS.length)] ?? 1,
      phase: this.random() * Math.PI * 2,
    }
  }

  update(seconds: number, horizon: number, wind: number): void {
    this.clock += seconds
    const slant = slantOf(wind)
    for (const drop of this.drops) {
      drop.y += drop.speed * seconds
      drop.x += drop.kind === 'snow' ? wind * 0.2 * seconds : drop.speed * slant * seconds
      if (drop.y < horizon) {
        continue
      }
      if ((drop.kind === 'rain' || drop.kind === 'heavy') && this.random() < 0.35) {
        this.splashes.push({ x: drop.x, age: 0 })
      }
      Object.assign(drop, this.spawn(-this.random() * 6))
    }
    for (const splash of this.splashes) {
      splash.age += seconds
    }
    this.splashes = this.splashes.filter((splash) => splash.age < SPLASH_SECONDS)
  }

  draw(ctx: CanvasRenderingContext2D, palette: Palette, horizon: number, wind: number): void {
    const slant = slantOf(wind)
    for (const kind of KINDS) {
      const motion = MOTION[kind]
      ctx.lineWidth = motion.width
      ctx.lineCap = 'round'
      for (const bucket of BUCKETS) {
        const path = new Path2D()
        let empty = true
        for (const drop of this.drops) {
          if (drop.kind !== kind || drop.alpha !== bucket || drop.pellet) {
            continue
          }
          const length = drop.speed * motion.streak
          path.moveTo(drop.x - slant * length, drop.y - length)
          path.lineTo(drop.x, drop.y)
          empty = false
        }
        if (!empty) {
          ctx.strokeStyle = hex(palette.rain, bucket * motion.alpha)
          ctx.stroke(path)
        }
      }
    }
    this.drawFlakes(ctx, palette, horizon)
    this.drawSplashes(ctx, palette, horizon)
  }

  /** Flakes and pellets in a few batched paths by brightness, each with a faint shaded rim. */
  private drawFlakes(ctx: CanvasRenderingContext2D, palette: Palette, horizon: number): void {
    const batches = new Map<number, { core: Path2D; rim: Path2D }>()
    for (const drop of this.drops) {
      if (!isFlake(drop)) {
        continue
      }
      const fade = smoothstep(horizon, horizon - 4, drop.y) * smoothstep(-2, 3, drop.y)
      const alpha = Math.round(drop.alpha * fade * 4) / 4
      if (alpha === 0) {
        continue
      }
      let batch = batches.get(alpha)
      if (!batch) {
        batch = { core: new Path2D(), rim: new Path2D() }
        batches.set(alpha, batch)
      }
      const x = drop.x + (drop.kind === 'snow' ? Math.sin(drop.phase + this.clock * 1.6) * 1.6 : 0)
      const radius = drop.pellet ? 0.65 : drop.size
      batch.rim.moveTo(x + radius + 0.45, drop.y + 0.2)
      batch.rim.arc(x, drop.y + 0.2, radius + 0.45, 0, Math.PI * 2)
      batch.core.moveTo(x + radius, drop.y)
      batch.core.arc(x, drop.y, radius, 0, Math.PI * 2)
    }
    for (const [alpha, batch] of batches) {
      ctx.fillStyle = hex(palette.cloudShade, alpha * MOTION.snow.alpha * 0.3)
      ctx.fill(batch.rim)
      ctx.fillStyle = hex(palette.snow, alpha * MOTION.snow.alpha)
      ctx.fill(batch.core)
    }
  }

  /** Rings spreading where drops meet the horizon, flat as seen from the side. */
  private drawSplashes(ctx: CanvasRenderingContext2D, palette: Palette, horizon: number): void {
    ctx.lineWidth = 0.5
    for (const splash of this.splashes) {
      const t = splash.age / SPLASH_SECONDS
      const radius = 0.6 + 2.2 * t
      ctx.strokeStyle = hex(palette.rain, 0.4 * (1 - t))
      ctx.beginPath()
      ctx.ellipse(splash.x, horizon - 0.6, radius, radius * 0.28, 0, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
}
