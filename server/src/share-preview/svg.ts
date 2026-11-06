import fs from 'node:fs'
import { converterPath, runConverter, type ConverterLimits } from '../converter.js'
import { escapeHtml } from '../share-markdown.js'
import { rasterSize } from './image.js'
import { converterError, imageTag, type ImageSlots, type PreviewImage, type RenderedPreview } from './preview.js'

const MB = 1024 * 1024
/** The longest side of a rasterized drawing, so no SVG asks for a giant bitmap. */
const SVG_SIDE_MAX = 2400
/** Drawings render at twice their size, for sharp lines on dense screens. */
const SCALE = 2
const FALLBACK_SIDE = 1200

const LIMITS: ConverterLimits = {
  timeoutMs: 30_000,
  cpuSeconds: 30,
  memoryBytes: 1024 * MB,
  fileBytes: 16 * MB,
  outputBytes: 16 * MB,
}

/** A few font folders; scanning every font on the host would take seconds a drawing. */
const FONT_DIRS = ['/usr/share/fonts/truetype/dejavu', '/usr/share/fonts/truetype/liberation'].filter((dir) =>
  fs.existsSync(dir),
)

const length = (value: string | undefined) => {
  const match = /^(\d+(?:\.\d+)?)(?:px)?$/.exec((value ?? '').trim())
  const parsed = match === null ? Number.NaN : Number(match[1])
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/** The drawing's own size from its root element: width and height in pixels, else its viewBox. */
export function svgSize(text: string): { width: number; height: number } | null {
  const root = /<svg\b[^>]*>/i.exec(text.slice(0, 65_536))?.[0] ?? ''
  const attribute = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(root)?.[1]
  const width = length(attribute('width'))
  const height = length(attribute('height'))
  if (width !== null && height !== null) {
    return { width, height }
  }
  const box = (attribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  const [, , boxWidth = 0, boxHeight = 0] = box
  return box.length === 4 && boxWidth > 0 && boxHeight > 0 ? { width: boxWidth, height: boxHeight } : null
}

/** The pixel box a drawing renders into: twice its size, inside the cap. */
export function renderBox(size: { width: number; height: number } | null): { width: number; height: number } {
  if (size === null) {
    return { width: FALLBACK_SIDE, height: FALLBACK_SIDE }
  }
  const scale = Math.min(SCALE, SVG_SIDE_MAX / size.width, SVG_SIDE_MAX / size.height)
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }
}

const fontArgs = () => [
  '--skip-system-fonts',
  ...FONT_DIRS.flatMap((dir) => ['--use-fonts-dir', dir]),
  '--font-family',
  'DejaVu Sans',
]

/** Rasterizes an SVG to PNG in the sandbox: resvg when the host has it, else rsvg-convert. */
export async function rasterizeSvg(svg: Buffer, box: { width: number; height: number }) {
  const [width, height] = [String(box.width), String(box.height)]
  const resvg = converterPath('resvg') !== null
  const result = await runConverter({
    program: resvg ? 'resvg' : 'rsvg-convert',
    args: resvg
      ? [...fontArgs(), '-w', width, '-h', height, '/in/input.svg', '/out/out.png']
      : ['-w', width, '-h', height, '-a', '-o', '/out/out.png', '/in/input.svg'],
    inputs: new Map([['input.svg', svg]]),
    limits: LIMITS,
  })
  const png = result.ok ? result.files.get('out.png') : undefined
  const size = png === undefined ? null : rasterSize(png)
  if (png === undefined || size === null) {
    return result.ok ? 'no image came out' : result.error
  }
  return { mime: 'image/png', bytes: png, ...size } satisfies PreviewImage
}

/** An SVG as a picture rendered on the server, with its source to read; never served as SVG. */
export async function svgPreview(name: string, content: Buffer, slots: ImageSlots): Promise<RenderedPreview> {
  const text = content.toString('utf8')
  const size = svgSize(text)
  const source = `<details class="source"><summary>View source</summary><pre class="text">${escapeHtml(text)}</pre></details>`
  const label =
    size === null
      ? 'SVG drawing'
      : `SVG drawing, ${String(Math.round(size.width))} \u00d7 ${String(Math.round(size.height))}`
  const image = await rasterizeSvg(content, renderBox(size))
  if (typeof image === 'string') {
    return { body: source, label, note: null, error: converterError('This SVG', image), thumb: null }
  }
  const src = slots.add(image)
  const shown = { ...image, width: Math.round(image.width / SCALE), height: Math.round(image.height / SCALE) }
  const picture = src === null ? '' : imageTag(src, shown, name, 'file drawing')
  return { body: picture + source, label, note: null, error: null, thumb: image }
}
