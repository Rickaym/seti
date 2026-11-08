import { randomBytes } from 'node:crypto'
import type { FileKind, ShareDiagramInput } from '@seti/shared'
import { escapeHtml } from '../share-markdown.js'

/** An image a preview shows from the share's own image path, such as a PDF page. */
export interface PreviewImage {
  mime: string
  bytes: Buffer
  width: number
  height: number
}

/** A file as a preview renderer gets it, after every share check has passed. */
export interface PreviewInput {
  name: string
  kind: FileKind
  /** The type the download is served as. */
  mime: string
  content: Buffer
  /** A Markdown file's snapshotted raster images, by the link the file names each with. */
  images: ReadonlyMap<string, { mime: string; bytes: Buffer }>
  /** Fences the browser drew for the page; a fence without one shows as code. */
  diagrams?: readonly ShareDiagramInput[]
}

/** What a renderer makes of a file; the page body is stored and served as it is. */
export interface RenderedPreview {
  body: string
  /** What the file is, such as "PDF, 12 pages"; it heads the link card too. */
  label: string
  /** What the page leaves out, such as "first 50 pages shown". */
  note: string | null
  /** Why a converter could not show the file; the page then falls back to source or download. */
  error: string | null
  /** A raster for the link card. */
  thumb: PreviewImage | null
}

/** Pages and output images a share stores, and the bytes they may take together. */
export const IMAGES_MAX = 50
export const IMAGE_BYTES_MAX = 20 * 1024 * 1024

/**
 * Stored images, each named in the body by a random key and its number. The page fills in the
 * share's image path when it is served, since the token is not known here and can change.
 */
export interface ImageSlots {
  readonly key: string
  readonly images: PreviewImage[]
  /** The src of the share's own download, for an audio or video element. */
  readonly raw: string
  /** The src for the image, or null when the share holds no more images. */
  add: (image: PreviewImage) => string | null
  /** The srcs for all the images, or null and none stored when they do not all fit. */
  addAll: (images: readonly PreviewImage[]) => string[] | null
}

export function imageSlots(): ImageSlots {
  const key = randomBytes(16).toString('hex')
  const images: PreviewImage[] = []
  let bytes = 0
  const fits = (more: readonly PreviewImage[]) =>
    images.length + more.length <= IMAGES_MAX &&
    bytes + more.reduce((sum, image) => sum + image.bytes.length, 0) <= IMAGE_BYTES_MAX
  const store = (image: PreviewImage) => {
    images.push(image)
    bytes += image.bytes.length
    return `${key}-${String(images.length)}`
  }
  return {
    key,
    images,
    raw: `${key}.raw`,
    add: (image) => (fits([image]) ? store(image) : null),
    addAll: (more) => (fits(more) ? more.map(store) : null),
  }
}

/** The body as served: each key becomes the share's image or download path, relative to its page. */
export const fillImages = (body: string, key: string | null, token: string): string =>
  key === null ? body : body.replaceAll(`${key}.raw`, `${token}/raw`).replaceAll(`${key}-`, `${token}/p/`)

/** The text with its first letter upper case. */
export const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

/** A count with thousands separators, as labels show it. */
export const count = (n: number) => n.toLocaleString('en-US')

/** "1 row" or "3,400 rows". */
export const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`

/** An image tag sized ahead of loading, so lazy pages do not jump as images arrive. */
export function imageTag(src: string, image: PreviewImage, alt: string, className: string): string {
  const size =
    image.width > 0 && image.height > 0 ? ` width="${String(image.width)}" height="${String(image.height)}"` : ''
  return `<img class="${className}" src="${src}"${size} alt="${escapeHtml(alt)}" loading="lazy" decoding="async">`
}

/** A line above the preview saying what it leaves out, such as "First 50 of 120 pages shown". */
export function noteLine(note: string | null): string {
  if (note === null) {
    return ''
  }
  const text = escapeHtml(capital(note))
  return `<p class="caption">${text}</p>`
}

/** A failed converter's message, as the share dialog and the page show it. */
export const converterError = (what: string, error: string) => `${what} could not be previewed: ${error}`
