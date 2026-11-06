import { detectTextType, type AttachmentKind } from '@seti/shared'

/** What a file is, judged from its first bytes; the name only refines a container format. */
export interface Sniffed {
  kind: AttachmentKind
  mime: string
  type: string
  /** The extension a file of this type should have, or null when the name's is as good. */
  ext: string | null
  width: number | null
  height: number | null
}

/** Bytes read to sniff a file; JPEG puts its size after EXIF data of up to 64 KB. */
export const SNIFF_BYTES = 256 * 1024

/** Images the API takes, within what Claude Code itself sends: 2000 px a side, 3.75 MB raw. */
export const SHOWN_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
const SHOWN_MAX_SIDE = 2000
const SHOWN_MAX_BYTES = 3_932_160

interface Magic {
  mime: string
  type: string
  ext: string
  test: (head: Buffer) => boolean
}

const ascii = (head: Buffer, at: number, text: string) => head.toString('latin1', at, at + text.length) === text
const bytes = (head: Buffer, at: number, ...values: number[]) => values.every((value, i) => head[at + i] === value)

const MAGIC: Magic[] = [
  { mime: 'image/png', type: 'PNG image', ext: 'png', test: (h) => bytes(h, 0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a) },
  { mime: 'image/jpeg', type: 'JPEG image', ext: 'jpg', test: (h) => bytes(h, 0, 0xff, 0xd8, 0xff) },
  { mime: 'image/gif', type: 'GIF image', ext: 'gif', test: (h) => ascii(h, 0, 'GIF87a') || ascii(h, 0, 'GIF89a') },
  { mime: 'image/webp', type: 'WebP image', ext: 'webp', test: (h) => ascii(h, 0, 'RIFF') && ascii(h, 8, 'WEBP') },
  {
    mime: 'image/bmp',
    type: 'BMP image',
    ext: 'bmp',
    test: (h) => ascii(h, 0, 'BM') && h.length > 18 && [40, 108, 124].includes(h.readUInt32LE(14)),
  },
  {
    mime: 'image/tiff',
    type: 'TIFF image',
    ext: 'tiff',
    test: (h) => bytes(h, 0, 0x49, 0x49, 0x2a, 0) || bytes(h, 0, 0x4d, 0x4d, 0, 0x2a),
  },
  {
    mime: 'image/heic',
    type: 'HEIC image',
    ext: 'heic',
    test: (h) => ascii(h, 4, 'ftyp') && /^(heic|heix|mif1|msf1)$/.test(h.toString('latin1', 8, 12)),
  },
  { mime: 'application/pdf', type: 'PDF', ext: 'pdf', test: (h) => ascii(h, 0, '%PDF-') },
  { mime: 'application/zip', type: 'ZIP archive', ext: 'zip', test: (h) => bytes(h, 0, 0x50, 0x4b, 0x03, 0x04) },
  { mime: 'application/gzip', type: 'gzip archive', ext: 'gz', test: (h) => bytes(h, 0, 0x1f, 0x8b) },
  {
    mime: 'application/x-bzip2',
    type: 'bzip2 archive',
    ext: 'bz2',
    test: (h) => ascii(h, 0, 'BZh') && /[1-9]/.test(h.toString('latin1', 3, 4)),
  },
  {
    mime: 'application/x-xz',
    type: 'xz archive',
    ext: 'xz',
    test: (h) => bytes(h, 0, 0xfd, 0x37, 0x7a, 0x58, 0x5a, 0),
  },
  {
    mime: 'application/x-7z-compressed',
    type: '7z archive',
    ext: '7z',
    test: (h) => bytes(h, 0, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c),
  },
  { mime: 'application/vnd.rar', type: 'RAR archive', ext: 'rar', test: (h) => ascii(h, 0, 'Rar!') },
  { mime: 'application/x-tar', type: 'tar archive', ext: 'tar', test: (h) => ascii(h, 257, 'ustar') },
  { mime: 'application/zstd', type: 'zstd archive', ext: 'zst', test: (h) => bytes(h, 0, 0x28, 0xb5, 0x2f, 0xfd) },
  {
    mime: 'application/x-sqlite3',
    type: 'SQLite database',
    ext: 'sqlite',
    test: (h) => ascii(h, 0, 'SQLite format 3'),
  },
  { mime: 'application/vnd.apache.parquet', type: 'Parquet file', ext: 'parquet', test: (h) => ascii(h, 0, 'PAR1') },
  { mime: 'application/wasm', type: 'WebAssembly module', ext: 'wasm', test: (h) => bytes(h, 0, 0, 0x61, 0x73, 0x6d) },
  { mime: 'application/x-elf', type: 'ELF binary', ext: '', test: (h) => bytes(h, 0, 0x7f, 0x45, 0x4c, 0x46) },
  {
    mime: 'application/x-msdownload',
    type: 'Windows binary',
    ext: 'exe',
    test: (h) => ascii(h, 0, 'MZ') && h.length > 64 && ascii(h, h.readUInt32LE(60), 'PE\0\0'),
  },
  {
    mime: 'application/x-mach-binary',
    type: 'Mach-O binary',
    ext: '',
    test: (h) => bytes(h, 0, 0xcf, 0xfa, 0xed, 0xfe) || bytes(h, 0, 0xce, 0xfa, 0xed, 0xfe),
  },
  { mime: 'audio/mpeg', type: 'MP3 audio', ext: 'mp3', test: (h) => ascii(h, 0, 'ID3') },
  { mime: 'audio/wav', type: 'WAV audio', ext: 'wav', test: (h) => ascii(h, 0, 'RIFF') && ascii(h, 8, 'WAVE') },
  { mime: 'audio/ogg', type: 'Ogg audio', ext: 'ogg', test: (h) => ascii(h, 0, 'OggS') },
  { mime: 'audio/flac', type: 'FLAC audio', ext: 'flac', test: (h) => ascii(h, 0, 'fLaC') },
  { mime: 'video/webm', type: 'WebM video', ext: 'webm', test: (h) => bytes(h, 0, 0x1a, 0x45, 0xdf, 0xa3) },
  { mime: 'video/mp4', type: 'MP4 video', ext: 'mp4', test: (h) => ascii(h, 4, 'ftyp') },
  { mime: 'font/woff2', type: 'WOFF2 font', ext: 'woff2', test: (h) => ascii(h, 0, 'wOF2') },
  { mime: 'font/woff', type: 'WOFF font', ext: 'woff', test: (h) => ascii(h, 0, 'wOFF') },
]

/** ZIP is the container of these formats, so their extension names them better. */
const ZIP_FORMATS: Record<string, [string, string]> = {
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Word document'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Excel workbook'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'PowerPoint deck'],
  odt: ['application/vnd.oasis.opendocument.text', 'OpenDocument text'],
  ods: ['application/vnd.oasis.opendocument.spreadsheet', 'OpenDocument sheet'],
  epub: ['application/epub+zip', 'EPUB book'],
  jar: ['application/java-archive', 'Java archive'],
  apk: ['application/vnd.android.package-archive', 'Android package'],
  whl: ['application/zip', 'Python wheel'],
}

const TEXT_MIMES: Record<string, string> = {
  json: 'application/json',
  jsonl: 'application/jsonl',
  md: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  svg: 'image/svg+xml',
  xml: 'application/xml',
  yaml: 'application/yaml',
}

/** Names by extension for text files, which content alone can only guess. */
const TEXT_NAMES: Record<string, string> = {
  txt: 'Text',
  md: 'Markdown',
  json: 'JSON',
  jsonl: 'JSON Lines',
  ndjson: 'JSON Lines',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  xml: 'XML',
  html: 'HTML',
  svg: 'SVG',
  csv: 'CSV',
  tsv: 'TSV',
  diff: 'Diff',
  patch: 'Diff',
  py: 'Python',
  ts: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  kt: 'Kotlin',
  c: 'C',
  h: 'C',
  cpp: 'C++',
  cc: 'C++',
  hpp: 'C++',
  sql: 'SQL',
  sh: 'Shell',
  bash: 'Shell',
  log: 'Log',
  ini: 'INI',
  env: 'Env',
  rb: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  css: 'CSS',
}

export const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** Text when the start decodes as UTF-8 and holds no NUL; a sequence cut at the end is fine. */
function asText(head: Buffer): string | null {
  if (head.includes(0)) {
    return null
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true })
  } catch {
    return null
  }
}

function jpegSize(head: Buffer): [number, number] | null {
  let at = 2
  while (at + 9 < head.length) {
    if (head[at] !== 0xff) {
      return null
    }
    const marker = head[at + 1] ?? 0
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return [head.readUInt16BE(at + 7), head.readUInt16BE(at + 5)]
    }
    at += 2 + head.readUInt16BE(at + 2)
  }
  return null
}

function webpSize(head: Buffer): [number, number] | null {
  const chunk = head.toString('latin1', 12, 16)
  if (chunk === 'VP8X' && head.length >= 30) {
    return [1 + head.readUIntLE(24, 3), 1 + head.readUIntLE(27, 3)]
  }
  if (chunk === 'VP8L' && head.length >= 25) {
    const bits = head.readUInt32LE(21)
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1]
  }
  if (chunk === 'VP8 ' && head.length >= 30) {
    return [head.readUInt16LE(26) & 0x3fff, head.readUInt16LE(28) & 0x3fff]
  }
  return null
}

export function imageSize(mime: string, head: Buffer): [number, number] | null {
  switch (mime) {
    case 'image/png':
      return head.length >= 24 ? [head.readUInt32BE(16), head.readUInt32BE(20)] : null
    case 'image/gif':
      return head.length >= 10 ? [head.readUInt16LE(6), head.readUInt16LE(8)] : null
    case 'image/jpeg':
      return jpegSize(head)
    case 'image/webp':
      return webpSize(head)
    default:
      return null
  }
}

function binary(head: Buffer, name: string, magic: Magic | undefined): Sniffed {
  const ext = extensionOf(name)
  const none = { width: null, height: null }
  if (magic === undefined) {
    const type = ext === '' ? 'Binary file' : `${ext.toUpperCase()} file`
    return { kind: 'file', mime: 'application/octet-stream', type, ext: null, ...none }
  }
  const zipped = magic.ext === 'zip' ? ZIP_FORMATS[ext] : undefined
  if (zipped !== undefined) {
    return { kind: 'file', mime: zipped[0], type: zipped[1], ext: null, ...none }
  }
  const size = imageSize(magic.mime, head)
  return {
    kind: magic.mime.startsWith('image/') ? 'image' : 'file',
    mime: magic.mime,
    type: magic.type,
    ext: magic.ext,
    width: size?.[0] ?? null,
    height: size?.[1] ?? null,
  }
}

/** Sniffs from the first bytes: a known signature, else text typed by extension or content. */
export function sniff(head: Buffer, name: string, paste: boolean, text: () => string): Sniffed {
  const magic = paste ? undefined : MAGIC.find((entry) => entry.test(head))
  if (magic !== undefined || asText(head) === null) {
    return binary(head, name, magic)
  }
  const named = paste ? undefined : TEXT_NAMES[extensionOf(name)]
  const detected = named === undefined ? detectTextType(text()) : null
  const ext = detected?.ext ?? extensionOf(name)
  return {
    kind: 'text',
    mime: TEXT_MIMES[ext] ?? 'text/plain',
    type: named ?? detected?.label ?? 'Text',
    ext: detected?.ext ?? null,
    width: null,
    height: null,
  }
}

/** Whether the model can be shown the image with the message, not only told its path. */
export const showable = (sniffed: Sniffed, size: number) =>
  (SHOWN_MIMES as readonly string[]).includes(sniffed.mime) &&
  size <= SHOWN_MAX_BYTES &&
  sniffed.width !== null &&
  sniffed.height !== null &&
  sniffed.width <= SHOWN_MAX_SIDE &&
  sniffed.height <= SHOWN_MAX_SIDE
