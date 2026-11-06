import { runConverter } from '../converter.js'
import { converterError, imageTag, type ImageSlots, type PreviewImage, type RenderedPreview } from './preview.js'

const MB = 1024 * 1024

/** The raster type the bytes start with, or null; anything else never renders as an image. */
export function rasterType(bytes: Buffer): string | null {
  const ascii = (start: number, end: number) => bytes.subarray(start, end).toString('latin1')
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return 'image/jpeg'
  }
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') {
    return 'image/gif'
  }
  return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP' ? 'image/webp' : null
}

export const dataUri = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`

/** Width and height from a PNG, GIF, WebP or JPEG header, or null when the bytes are not one. */
export function rasterSize(bytes: Buffer): { width: number; height: number } | null {
  switch (rasterType(bytes)) {
    case 'image/png':
      return bytes.length >= 24 ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null
    case 'image/gif':
      return bytes.length >= 10 ? { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) } : null
    case 'image/webp':
      return webpSize(bytes)
    case 'image/jpeg':
      return jpegSize(bytes)
    case null:
    default:
      return null
  }
}

function webpSize(bytes: Buffer): { width: number; height: number } | null {
  const chunk = bytes.subarray(12, 16).toString('latin1')
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) }
  }
  if (chunk === 'VP8 ' && bytes.length >= 30) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
  }
  if (chunk === 'VP8L' && bytes.length >= 25) {
    const bits = bytes.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  return null
}

/** Start-of-frame markers, which carry the size; the others are tables and extras. */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  let at = 2
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) {
      return null
    }
    const marker = bytes[at + 1] ?? 0
    if (SOF.has(marker)) {
      return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) }
    }
    at += 2 + bytes.readUInt16BE(at + 2)
  }
  return null
}

/** A raster image the browser shows itself, from the share's image path, with its size. */
export function rasterPreview(name: string, bytes: Buffer, mime: string, slots: ImageSlots): RenderedPreview {
  const size = rasterSize(bytes) ?? { width: 0, height: 0 }
  const known = size.width > 0 && size.height > 0
  const format = mime.replace('image/', '').toUpperCase()
  const label = known ? `${format} image, ${String(size.width)} \u00d7 ${String(size.height)}` : `${format} image`
  const image: PreviewImage = { mime, bytes, ...size }
  const src = slots.add(image)
  return {
    body: src === null ? '' : imageTag(src, image, name, 'file'),
    label,
    note: null,
    error: null,
    thumb: known ? image : null,
  }
}

/** Formats browsers do not all show, by extension, which ffmpeg turns into WebP. */
export const CONVERTED_IMAGES: Readonly<Record<string, string>> = {
  bmp: 'BMP',
  tif: 'TIFF',
  tiff: 'TIFF',
  avif: 'AVIF',
  ico: 'ICO',
}

/** The longest side a converted image keeps. */
const SIDE_MAX = 2000

const FFMPEG_LIMITS = {
  timeoutMs: 30_000,
  cpuSeconds: 30,
  memoryBytes: 1024 * MB,
  fileBytes: 8 * MB,
  outputBytes: 8 * MB,
}

const SCALE = `scale=w='min(${String(SIDE_MAX)},iw)':h='min(${String(SIDE_MAX)},ih)':force_original_aspect_ratio=decrease`

/** Decodes an image in the sandbox and stores it as one WebP, at most 2,000 pixels a side. */
export async function convertedImage(name: string, bytes: Buffer, format: string, slots: ImageSlots) {
  const result = await runConverter({
    program: 'ffmpeg',
    args: ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-i', '/in/input'].concat([
      '-frames:v',
      '1',
      '-vf',
      SCALE,
      '-c:v',
      'libwebp',
      '-quality',
      '80',
      '/out/image.webp',
    ]),
    inputs: new Map([['input', bytes]]),
    limits: FFMPEG_LIMITS,
  })
  const webp = result.ok ? result.files.get('image.webp') : undefined
  const size = webp === undefined ? null : rasterSize(webp)
  if (webp === undefined || size === null) {
    const error = converterError(`This ${format} image`, result.ok ? 'no image came out' : result.error)
    return { body: '', label: `${format} image`, note: null, error, thumb: null } satisfies RenderedPreview
  }
  const image: PreviewImage = { mime: 'image/webp', bytes: webp, ...size }
  const src = slots.add(image)
  const scaled = Math.max(size.width, size.height) >= SIDE_MAX
  const dimensions = `${String(size.width)} \u00d7 ${String(size.height)}`
  const shown = scaled ? `shown at ${dimensions}` : dimensions
  return {
    body: src === null ? '' : imageTag(src, image, name, 'file'),
    label: `${format} image, ${shown}`,
    note: null,
    error: null,
    thumb: image,
  } satisfies RenderedPreview
}
