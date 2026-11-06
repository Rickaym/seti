import fs from 'node:fs'
import path from 'node:path'
import type { Browser, Page } from '@playwright/test'
import { newPage, openContext, shootTo } from './capture.js'
import type { Encoder } from './encoder.js'
import * as scenes from './scenes.js'

const ROOT = path.join(import.meta.dirname, '../..')
const GRAPHICS = path.join(ROOT, 'android/play/listings/en-US/graphics')
const ICON = path.join(ROOT, 'ui/public/icon-maskable-512.png')
const MOON = path.join(ROOT, 'ui/public/icon-512.png')
const FONT = path.join(
  ROOT,
  'ui/node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2',
)

/** The Play listing's phone screenshots, in the order the store shows them. */
const FRAMES: [name: string, scene: (page: Page) => Promise<void>][] = [
  ['1-needs-you', scenes.phoneList],
  ['2-permission', scenes.phonePermission],
  ['3-assistant', scenes.phoneEa],
]

const FEATURE = { width: 1024, height: 500 }
const STARS = 46
const GOLDEN_RATIO = 0.618_033_988_75

const dataUrl = (file: string, type: string) => `data:${type};base64,${fs.readFileSync(file).toString('base64')}`

/** Stars spread evenly over the sky, clear of the wordmark and the moon. */
function stars(): string {
  const dots: string[] = []
  for (let i = 1; dots.length < STARS && i < STARS * 4; i++) {
    const x = ((i * GOLDEN_RATIO) % 1) * FEATURE.width
    const y = ((i * 0.754_877_666) % 1) * FEATURE.height * 0.9
    const behindText = x > 40 && x < 600 && y > 120 && y < 380
    const behindMoon = Math.hypot(x - 790, y - 250) < 190
    if (!behindText && !behindMoon) {
      const size = 1 + (i % 3) * 0.6
      const glow = 0.35 + ((i * 7) % 10) / 20
      dots.push(
        `<i style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;--s:${String(size)}px;--a:${String(glow)}"></i>`,
      )
    }
  }
  return dots.join('')
}

function featureGraphic(): string {
  return `<!doctype html><html><head><style>
  @font-face { font-family: 'JetBrains Mono'; src: url('${dataUrl(FONT, 'font/woff2')}') format('woff2'); font-weight: 100 800; }
  html, body { margin: 0; }
  body { width: ${String(FEATURE.width)}px; height: ${String(FEATURE.height)}px; overflow: hidden; position: relative;
    background: linear-gradient(180deg, oklch(0.12 0.02 265) 0%, oklch(0.21 0.03 268) 70%, oklch(0.27 0.06 288) 100%);
    font-family: 'JetBrains Mono', monospace; color: oklch(0.97 0.005 255); }
  i { position: absolute; width: var(--s); height: var(--s); border-radius: 50%; background: oklch(0.95 0.02 250);
    opacity: var(--a); }
  .moon { position: absolute; left: 640px; top: 100px; width: 300px; height: 300px; }
  .glow { position: absolute; left: 590px; top: 50px; width: 400px; height: 400px; border-radius: 50%;
    background: radial-gradient(circle, oklch(0.95 0.02 90 / 18%) 0%, transparent 65%); }
  .text { position: absolute; left: 72px; top: 150px; width: 520px; }
  h1 { margin: 0; font-size: 112px; font-weight: 700; letter-spacing: 0.06em; line-height: 1; }
  p { margin: 28px 0 0; font-size: 28px; line-height: 1.35; color: oklch(0.8 0.015 255); }
</style></head><body>
  ${stars()}
  <div class="glow"></div>
  <img class="moon" src="${dataUrl(MOON, 'image/png')}" alt="">
  <div class="text"><h1>Seti</h1><p>Your coding agents, on your home screen.</p></div>
</body></html>`
}

/** A static page to render at its exact size. */
interface Still {
  html: string
  size: { width: number; height: number }
  file: string
}

async function still(browser: Browser, encoder: Encoder, { html, size, file }: Still) {
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1 })
  const page = await context.newPage()
  await page.setContent(html)
  await shootTo(page, encoder, file, { type: 'png' })
  await context.close()
}

/** Writes the Play listing graphics: phone screenshots, the icon and the feature graphic. */
export async function playGraphics(browser: Browser, baseURL: string, encoder: Encoder): Promise<void> {
  for (const [name, scene] of FRAMES) {
    const context = await openContext(browser, baseURL, { device: 'android', theme: 'dark' })
    const page = await newPage(context)
    await scene(page)
    await shootTo(page, encoder, path.join(GRAPHICS, 'phone-screenshots', `${name}.jpg`), { type: 'jpeg' })
    await context.close()
  }
  const icon = `<!doctype html><html><body style="margin:0"><img src="${dataUrl(ICON, 'image/png')}" width="512" height="512" alt=""></body></html>`
  await still(browser, encoder, {
    html: icon,
    size: { width: 512, height: 512 },
    file: path.join(GRAPHICS, 'icon/icon.png'),
  })
  await still(browser, encoder, {
    html: featureGraphic(),
    size: FEATURE,
    file: path.join(GRAPHICS, 'feature-graphic/feature-graphic.png'),
  })
}
