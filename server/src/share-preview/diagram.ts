import type { ShareDiagramInput } from '@seti/shared'
import { fenceKey, type MarkdownFence } from '@seti/shared/markdown-fences'
import { escapeHtml } from '../share-markdown.js'
import { capital, imageTag, type ImageSlots, type PreviewImage, type RenderedPreview } from './preview.js'
import { PAGE_BACKGROUND } from './style.js'
import { rasterizeSvg, renderBox, svgSize } from './svg.js'

/** Diagrams render at three times their size, so 200% stays sharp on a dense screen. */
const DIAGRAM_SCALE = 3
const DIAGRAM_SIDE_MAX = 4096

/** A diagram as the share stores it: its light and dark images and the size it reads at. */
export interface DrawnDiagram {
  light: string
  dark: string
  width: number
  height: number
  thumb: PreviewImage
}

/** Rasterizes both drawings in the sandbox into the share's images; null when either fails. */
async function draw(diagram: ShareDiagramInput, slots: ImageSlots): Promise<DrawnDiagram | null> {
  const size = svgSize(diagram.light)
  if (size === null) {
    return null
  }
  const box = renderBox(size, { scale: DIAGRAM_SCALE, sideMax: DIAGRAM_SIDE_MAX })
  const [light, dark] = await Promise.all([
    rasterizeSvg(Buffer.from(diagram.light), box, PAGE_BACKGROUND.light),
    rasterizeSvg(Buffer.from(diagram.dark), box, PAGE_BACKGROUND.dark),
  ])
  if (typeof light === 'string' || typeof dark === 'string') {
    return null
  }
  const [lightSrc, darkSrc] = slots.addAll([light, dark]) ?? []
  if (lightSrc === undefined || darkSrc === undefined) {
    return null
  }
  const [width, height] = [Math.max(1, Math.round(size.width)), Math.max(1, Math.round(size.height))]
  return { light: lightSrc, dark: darkSrc, width, height, thumb: light }
}

/**
 * The drawings of the fences the file has, by fence key, each drawn once. A drawing whose
 * language and text match no fence is never rasterized; a fence it fails for stays code.
 */
export async function drawDiagrams(
  diagrams: readonly ShareDiagramInput[],
  fences: readonly MarkdownFence[],
  slots: ImageSlots,
): Promise<Map<string, DrawnDiagram>> {
  const wanted = new Set(fences.map((fence) => fenceKey(fence.language, fence.source)))
  const drawn = new Map<string, DrawnDiagram>()
  for (const diagram of diagrams) {
    const key = fenceKey(diagram.language, diagram.source)
    if (wanted.has(key) && !drawn.has(key)) {
      const made = await draw(diagram, slots)
      if (made !== null) {
        drawn.set(key, made)
      }
    }
  }
  return drawn
}

const ZOOMS = [
  { id: 'fit', label: 'Fit' },
  { id: '1', label: '100%' },
  { id: '2', label: '200%' },
]

/** A diagram with Fit, 100% and 200% radios that size it by CSS alone, and its full-size image. */
export function diagramFigure(drawn: DrawnDiagram, index: number, alt: string): string {
  const group = `seti-d${String(index)}`
  const choices = ZOOMS.map(({ id, label }, n) => {
    const input = `<input type="radio" name="${group}" id="${group}-${id}" class="z-${id}"${n === 0 ? ' checked' : ''}>`
    return `${input}<label for="${group}-${id}">${label}</label>`
  }).join('')
  const full = (scheme: 'light' | 'dark') =>
    `<a class="full ${scheme}" href="${drawn[scheme]}" title="Open the image at full size">Full size</a>`
  const image = imageTag(drawn.light, { ...drawn.thumb, width: drawn.width, height: drawn.height }, alt, 'diagram')
  const picture = `<picture><source media="(prefers-color-scheme: dark)" srcset="${drawn.dark}">${image}</picture>`
  return [
    `<figure class="diagram" style="--w:${String(drawn.width)}px">`,
    choices,
    full('light'),
    full('dark'),
    `<div class="frame">${picture}</div></figure>`,
  ].join('')
}

/** Text as the browser read it, so a byte order mark does not keep a drawing from matching. */
const asRead = (content: Buffer) => content.toString('utf8').replace(/^\uFEFF/, '')

/**
 * A file that is one diagram, such as a .mmd file, drawn when the browser sent a drawing of
 * exactly its text in the language its kind names; else null and the file shows as text.
 */
export async function diagramFile(
  input: { kind: string; content: Buffer },
  diagrams: readonly ShareDiagramInput[],
  slots: ImageSlots,
): Promise<RenderedPreview | null> {
  const fence = { language: input.kind, source: asRead(input.content) }
  if (!diagrams.some((diagram) => diagram.language === fence.language)) {
    return null
  }
  const drawn = (await drawDiagrams(diagrams, [fence], slots)).get(fenceKey(fence.language, fence.source))
  if (drawn === undefined) {
    return null
  }
  const what = `${capital(fence.language)} diagram`
  const source = `<details class="source"><summary>View source</summary><pre class="text">${escapeHtml(fence.source)}</pre></details>`
  const label = `${what}, ${String(drawn.width)} \u00d7 ${String(drawn.height)}`
  return { body: diagramFigure(drawn, 1, what) + source, label, note: null, error: null, thumb: drawn.thumb }
}
