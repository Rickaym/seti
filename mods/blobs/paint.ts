import { contrast, hexOf, oklch, rgbOf, rgbOfOklch, type Lch } from '@seti/mod-api'

/** The body of an agent with no colour: one grey that reads on light and dark pages alike. */
export const GREY: Lch = { l: 0.62, c: 0, h: 0 }

/** How much of its own colour a stopped agent keeps; the rest leans toward the grey. */
export const FADED_SHARE = 0.4

/** The two faces: a very dark and a very light shade of the body's own hue. */
const FACE = { dark: { l: 0.24, c: 0.05 }, light: { l: 0.97, c: 0.02 } } as const

/** Bodies darker or lighter than these OKLCH lightnesses get a thin edge on a page like them. */
const EDGE = { dark: 0.4, light: 0.78 } as const

/** Whether a body is dark or light enough to need an edge on a page of its own lightness. */
type BlobTone = 'dark' | 'light' | 'mid'

/** A blob's colours, worked out from its agent's colour alone, so both themes draw it the same. */
export interface BlobPaint {
  body: string
  face: string
  tone: BlobTone
}

/** OKLab's mix toward a neutral grey: lightness moves toward it and chroma shrinks, hue kept. */
const toward = (lch: Lch, grey: Lch, share: number): Lch => ({
  l: grey.l + (lch.l - grey.l) * share,
  c: lch.c * share,
  h: lch.h,
})

function toneOf(lightness: number): BlobTone {
  if (lightness < EDGE.dark) {
    return 'dark'
  }
  return lightness > EDGE.light ? 'light' : 'mid'
}

/** The face that reads best on a body: whichever of the dark and light shades contrasts more. */
export function faceOn(body: string): string {
  const rgb = rgbOf(body)
  const { c, h } = oklch(rgb)
  const shade = (face: { l: number; c: number }) => rgbOfOklch({ l: face.l, c: Math.min(c, face.c), h })
  const [dark, light] = [shade(FACE.dark), shade(FACE.light)]
  return hexOf(contrast(dark, rgb) >= contrast(light, rgb) ? dark : light)
}

/** A blob's body, face and tone from its agent's chosen colour, or the grey with none. */
export function blobPaint(color: string | null, faded: boolean): BlobPaint {
  const own = color === null ? GREY : oklch(rgbOf(color))
  const lch = faded ? toward(own, GREY, FADED_SHARE) : own
  const body = color !== null && !faded ? color : hexOf(rgbOfOklch(lch))
  return { body, face: faceOn(body), tone: toneOf(lch.l) }
}
