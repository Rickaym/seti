import path from 'node:path'
import type { FileKind } from '@seti/shared'

const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  ogv: 'video/ogg',
}

const SPREADSHEET_TYPES: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  xls: 'application/vnd.ms-excel',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
}

export function contentType(name: string, kind: FileKind): string {
  const extension = path.extname(name).slice(1).toLowerCase()
  switch (kind) {
    case 'pdf':
      return 'application/pdf'
    case 'image':
    case 'audio':
    case 'video':
      return MEDIA_TYPES[extension] ?? 'application/octet-stream'
    case 'spreadsheet':
      return SPREADSHEET_TYPES[extension] ?? 'application/octet-stream'
    case 'markdown':
      return 'text/markdown; charset=utf-8'
    case 'mermaid':
      return 'text/vnd.mermaid; charset=utf-8'
    case 'csv':
      return extension === 'tsv' ? 'text/tab-separated-values; charset=utf-8' : 'text/csv; charset=utf-8'
    case 'text':
      return 'text/plain; charset=utf-8'
    case 'binary':
      return 'application/octet-stream'
  }
}
