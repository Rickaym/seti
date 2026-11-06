import { hex, type Palette } from './palette'
import { COLUMN, type Columns, type SceneStar, samplerOf, type Sampler } from './scene'

const between = (low: number, high: number, t: number) => low + (high - low) * t

interface Flash {
  x: number
  start: number
}

/** Gentle two-pulse envelope: a 70 ms rise, a slow fall, a fainter echo; about 0.7 s in all. */
function flashLevel(age: number): number {
  const pulse = (at: number, peak: number, fall: number) => {
    const t = age - at
    if (t < 0) {
      return 0
    }
    return t < 0.07 ? peak * (t / 0.07) : peak * Math.exp(-(t - 0.07) / fall)
  }
  return Math.min(1, pulse(0, 1, 0.12) + pulse(0.26, 0.55, 0.16))
}

/** Rare, soft lightning inside the storm clouds: at most one flash every six seconds. */
export class Lightning {
  private sampler: Sampler = samplerOf(new Float32Array(0))
  private next = 0
  private flash: Flash | null = null

  private readonly random: () => number

  constructor(random: () => number) {
    this.random = random
  }

  configure(columns: Columns, now: number): void {
    this.sampler = samplerOf(columns.thunder)
    if (this.next === 0) {
      this.next = now + between(2, 6, this.random())
    }
  }

  get possible(): boolean {
    return this.sampler.total > 0
  }

  get flashing(): boolean {
    return this.flash !== null
  }

  update(now: number): void {
    if (this.flash !== null && now - this.flash.start > 0.9) {
      this.flash = null
    }
    if (this.flash === null && this.possible && now >= this.next) {
      this.flash = { x: (this.sampler.pick(this.random()) + 0.5) * COLUMN, start: now }
      this.next = now + between(6, 16, this.random())
    }
  }

  /** Lights only what is already drawn, so the flash shows on the clouds and not the open sky. */
  draw(ctx: CanvasRenderingContext2D, palette: Palette, horizon: number, now: number): void {
    if (this.flash === null) {
      return
    }
    const level = flashLevel(now - this.flash.start)
    if (level < 0.01) {
      return
    }
    ctx.save()
    ctx.globalCompositeOperation = 'source-atop'
    ctx.translate(this.flash.x, horizon * 0.35)
    ctx.scale(3.2, 1)
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, horizon * 1.1)
    glow.addColorStop(0, hex(palette.lightning, 0.5 * level))
    glow.addColorStop(0.45, hex(palette.lightning, 0.22 * level))
    glow.addColorStop(1, hex(palette.lightning, 0))
    ctx.fillStyle = glow
    ctx.fillRect(-horizon * 1.1, -horizon * 1.1, horizon * 2.2, horizon * 2.2)
    ctx.restore()
  }
}

interface Meteor {
  x: number
  y: number
  dx: number
  dy: number
  speed: number
  length: number
  start: number
  duration: number
  brightness: number
}

/** Now and then a shooting star over the dark, clear parts of the night; none under cloud. */
export class Meteors {
  private sampler: Sampler = samplerOf(new Float32Array(0))
  private weights: Float32Array = new Float32Array(0)
  private next = 0
  private meteor: Meteor | null = null

  private readonly random: () => number

  constructor(random: () => number) {
    this.random = random
  }

  configure(columns: Columns, now: number): void {
    this.weights = columns.meteor
    this.sampler = samplerOf(columns.meteor.map((weight) => (weight > 0.5 ? weight : 0)))
    if (this.next === 0) {
      this.next = now + between(3, 10, this.random())
    }
  }

  get possible(): boolean {
    return this.sampler.total > 2
  }

  get flying(): boolean {
    return this.meteor !== null
  }

  update(now: number, horizon: number): void {
    if (this.meteor !== null && now - this.meteor.start > this.meteor.duration) {
      this.meteor = null
    }
    if (this.meteor !== null || now < this.next) {
      return
    }
    this.next = now + between(15, 40, this.random())
    if (!this.possible) {
      return
    }
    const index = this.sampler.pick(this.random())
    const direction = this.random() < 0.5 ? -1 : 1
    const drop = between(0.3, 0.55, this.random())
    const norm = Math.hypot(1, drop)
    this.meteor = {
      x: (index + 0.5) * COLUMN,
      y: horizon * between(0.08, 0.35, this.random()),
      dx: direction / norm,
      dy: drop / norm,
      speed: between(70, 105, this.random()),
      length: between(14, 24, this.random()),
      start: now,
      duration: between(0.55, 0.85, this.random()),
      brightness: this.weights[index] ?? 0,
    }
  }

  draw(ctx: CanvasRenderingContext2D, palette: Palette, now: number): void {
    const meteor = this.meteor
    if (meteor === null) {
      return
    }
    const t = (now - meteor.start) / meteor.duration
    const level = Math.sin(Math.PI * Math.min(1, Math.max(0, t))) ** 0.8 * meteor.brightness
    const travelled = meteor.speed * (now - meteor.start)
    const headX = meteor.x + meteor.dx * travelled
    const headY = meteor.y + meteor.dy * travelled
    const tail = Math.min(meteor.length, travelled)
    const tailX = headX - meteor.dx * tail
    const tailY = headY - meteor.dy * tail
    const streak = ctx.createLinearGradient(tailX, tailY, headX, headY)
    streak.addColorStop(0, hex(palette.meteor, 0))
    streak.addColorStop(1, hex(palette.meteor, 0.85 * level))
    ctx.strokeStyle = streak
    ctx.lineWidth = 0.9
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(tailX, tailY)
    ctx.lineTo(headX, headY)
    ctx.stroke()
    const head = ctx.createRadialGradient(headX, headY, 0, headX, headY, 2.2)
    head.addColorStop(0, hex(palette.meteor, 0.9 * level))
    head.addColorStop(1, hex(palette.meteor, 0))
    ctx.fillStyle = head
    ctx.fillRect(headX - 2.2, headY - 2.2, 4.4, 4.4)
  }
}

interface Twinkler {
  star: SceneStar
  period: number
  phase: number
}

/** Brief glints on the brighter stars, a few at a time, as the air shimmers. */
export class Twinkle {
  private stars: Twinkler[] = []

  configure(stars: readonly SceneStar[]): void {
    this.stars = stars
      .filter((star) => star.opacity * star.weight > 0.3)
      .map((star, index) => ({ star, period: 2.6 + ((index * 0.618) % 1) * 3.4, phase: (index * 0.382) % 1 }))
  }

  get active(): boolean {
    return this.stars.length > 0
  }

  draw(ctx: CanvasRenderingContext2D, palette: Palette, now: number): void {
    for (const { star, period, phase } of this.stars) {
      const wave = Math.sin(2 * Math.PI * (now / period + phase))
      const glint = wave > 0 ? wave ** 6 * star.opacity * 0.75 : 0
      if (glint < 0.02) {
        continue
      }
      const radius = 1.6 + star.weight * 1.2
      const halo = ctx.createRadialGradient(star.x, star.y, 0, star.x, star.y, radius)
      halo.addColorStop(0, hex(palette.star, glint))
      halo.addColorStop(1, hex(palette.star, 0))
      ctx.fillStyle = halo
      ctx.fillRect(star.x - radius, star.y - radius, radius * 2, radius * 2)
    }
  }
}
