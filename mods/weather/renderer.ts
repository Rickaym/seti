import { CloudField, FogWisps, paintFog, paintVeil } from './clouds'
import type { Palette } from './palette'
import { Rainfall } from './precipitation'
import { type Columns, columnsOf, seededRandom, type WeatherScene } from './scene'
import { Lightning, Meteors, Twinkle } from './sky-events'

/** Frame rates: falling rain needs some pace; drifting clouds and glints need very little. */
const FAST_FPS = 24
const SLOW_FPS = 12
const MAX_STEP_SECONDS = 0.1
/** A frame waits for the vsync after its timer, so the timer fires half a vsync early. */
const VSYNC_SLACK_MS = 8

/** The layers of the weather: the still cloud deck, the moving sky and the still fog in front. */
export interface WeatherLayers {
  back: HTMLCanvasElement
  main: HTMLCanvasElement
  front: HTMLCanvasElement
}

/** Draws the weather of a scene, animating only while the band can be seen. */
export class WeatherRenderer {
  private readonly ctx: CanvasRenderingContext2D | null
  private readonly random = seededRandom(20_260_928)
  private readonly clouds = new CloudField()
  private readonly wisps = new FogWisps()
  private readonly rain = new Rainfall(this.random)
  private readonly lightning = new Lightning(this.random)
  private readonly meteors = new Meteors(this.random)
  private readonly twinkle = new Twinkle()
  private scene: WeatherScene | null = null
  private columns: Columns | null = null
  private palette: Palette | null = null
  private foggy = false
  private dpr = 1
  private pageVisible = true
  private onscreen = true
  private timer = 0
  private frameId = 0
  private last = 0

  private readonly layers: WeatherLayers

  constructor(layers: WeatherLayers) {
    this.layers = layers
    this.ctx = layers.main.getContext('2d')
  }

  setPalette(palette: Palette): void {
    this.palette = palette
    this.clouds.invalidate()
    this.wisps.paint(palette, this.dpr)
    this.rebuild()
  }

  setScene(scene: WeatherScene): void {
    const now = performance.now() / 1000
    this.scene = scene
    this.dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
    const width = Math.max(1, Math.round(scene.width * this.dpr))
    const height = Math.max(1, Math.round(scene.height * this.dpr))
    for (const layer of [this.layers.back, this.layers.main, this.layers.front]) {
      if (layer.width !== width || layer.height !== height) {
        layer.width = width
        layer.height = height
        this.clouds.invalidate()
      }
    }
    const columns = columnsOf(scene)
    this.columns = columns
    this.clouds.layout(scene)
    this.wisps.layout(scene)
    this.rain.configure(columns, scene.horizon)
    this.lightning.configure(columns, now)
    this.meteors.configure(columns, now)
    this.twinkle.configure(scene.stars)
    this.rebuild()
  }

  setPageVisible(visible: boolean): void {
    this.pageVisible = visible
    this.reschedule()
  }

  setOnscreen(onscreen: boolean): void {
    this.onscreen = onscreen
    this.reschedule()
  }

  destroy(): void {
    this.stop()
    this.scene = null
  }

  private rebuild(): void {
    const { scene, columns, palette } = this
    if (scene === null || columns === null || palette === null) {
      return
    }
    paintVeil(this.layers.back, scene, columns, palette)
    this.foggy = paintFog(this.layers.front, scene, columns, palette)
    this.draw(performance.now() / 1000)
    this.reschedule()
  }

  private fps(): number {
    const { scene, columns } = this
    if (scene === null || columns === null || scene.reducedMotion) {
      return 0
    }
    if (this.rain.active || this.lightning.possible || this.meteors.flying) {
      return FAST_FPS
    }
    const drifting = CloudField.visible(columns) || this.foggy
    return drifting || this.twinkle.active || this.meteors.possible ? SLOW_FPS : 0
  }

  private stop(): void {
    window.clearTimeout(this.timer)
    window.cancelAnimationFrame(this.frameId)
    this.timer = 0
    this.frameId = 0
  }

  private reschedule(): void {
    this.stop()
    this.last = performance.now()
    this.schedule()
  }

  private schedule(): void {
    const fps = this.fps()
    if (fps === 0 || !this.pageVisible || !this.onscreen || this.timer !== 0 || this.frameId !== 0) {
      return
    }
    const wait = Math.max(0, 1000 / fps - (performance.now() - this.last) - VSYNC_SLACK_MS)
    this.timer = window.setTimeout(() => {
      this.timer = 0
      this.frameId = window.requestAnimationFrame(this.frame)
    }, wait)
  }

  private readonly frame = (time: number) => {
    this.frameId = 0
    const seconds = Math.min(MAX_STEP_SECONDS, Math.max(0, (time - this.last) / 1000))
    this.last = time
    this.step(seconds, time / 1000)
    this.draw(time / 1000)
    this.schedule()
  }

  private step(seconds: number, now: number): void {
    const scene = this.scene
    if (scene === null) {
      return
    }
    this.clouds.drift(seconds, scene.field.drift)
    this.wisps.drift(seconds, scene.field.drift)
    this.rain.update(seconds, scene.horizon, scene.field.drift)
    this.lightning.update(now)
    this.meteors.update(now, scene.horizon)
  }

  private draw(now: number): void {
    const { ctx, scene, columns, palette } = this
    if (ctx === null || scene === null || columns === null || palette === null) {
      return
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, scene.width, scene.height)
    if (!scene.reducedMotion) {
      this.twinkle.draw(ctx, palette, now)
      this.meteors.draw(ctx, palette, now)
    }
    this.clouds.draw(ctx, columns, palette, this.dpr)
    if (!scene.reducedMotion) {
      this.lightning.draw(ctx, palette, scene.horizon, now)
    }
    if (this.foggy) {
      this.wisps.draw(ctx, columns)
    }
    this.rain.draw(ctx, palette, scene.horizon, scene.field.drift)
  }
}
