import fs from 'node:fs'
import path from 'node:path'
import {
  isTextKind,
  kindByName,
  SHARE_MAX_BYTES,
  type FileKind,
  type ShareFinding,
  secretNameProblem,
} from '@seti/shared'
import { SETI_HOME, WORKTREE_ROOT } from './config.js'
import { contentType } from './content-type.js'
import { HttpError } from './http.js'
import { credentialFindings } from './scrub.js'
import { markdownImages } from './share-markdown.js'
import { rasterType } from './share-preview/image.js'
import { rendersMarkdown } from './share-preview/render.js'
import type { ShareAssetRow } from './store/shares.js'
import { locate, looksLikeText, openChecked, realOr, sha256, within, type FileContext } from './task-files.js'

const ASSETS_MAX = 50

/** Seti's own home holds credentials; only the task's workspace and its worktrees share from it. */
function inSetiData(real: string, files: FileContext): boolean {
  const home = realOr(SETI_HOME)
  const worktrees = realOr(WORKTREE_ROOT)
  if (!within(real, home)) {
    return false
  }
  return !within(real, files.rules.workspace) && !(within(real, worktrees) && real !== worktrees)
}

interface CheckedFile {
  rel: string
  real: string
  name: string
  bytes: Buffer
}

/** Reads one file through the Files rules, the deny list and the size left, or refuses it. */
function readChecked(files: FileContext, root: string, raw: string, room: number): CheckedFile {
  const at = locate(files, root, raw)
  if (at.real === null) {
    throw new HttpError(404, `${at.rel} does not exist`)
  }
  const name = path.basename(at.rel)
  const denied =
    secretNameProblem(at.rel) ??
    secretNameProblem(at.real) ??
    (inSetiData(at.real, files) ? "is Seti's own data" : null)
  if (denied !== null) {
    throw new HttpError(403, `${at.rel} ${denied}; it cannot be shared`)
  }
  if (fs.statSync(at.real).isDirectory()) {
    throw new HttpError(400, `${at.rel} is a folder; share one file`)
  }
  const fd = openChecked(at.real)
  try {
    const size = fs.fstatSync(fd).size
    if (size > room) {
      throw new HttpError(413, `${at.rel} is larger than the 10 MB a share holds`)
    }
    const bytes = Buffer.alloc(size)
    let read = 0
    while (read < size) {
      const got = fs.readSync(fd, bytes, read, size - read, read)
      if (got === 0) {
        break
      }
      read += got
    }
    return { rel: at.rel, real: at.real, name, bytes: bytes.subarray(0, read) }
  } finally {
    fs.closeSync(fd)
  }
}

/** A link to a file near the Markdown file, as a path in its root; null for remote or odd links. */
function localImagePath(link: string, markdownRel: string): string | null {
  if (link === '' || /^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith('/') || link.startsWith('#')) {
    return null
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(link.split(/[?#]/, 1)[0] ?? '')
  } catch {
    return null
  }
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(markdownRel), decoded))
  return joined.startsWith('..') || joined.includes('\0') ? null : joined
}

interface MarkdownImages {
  assets: ShareAssetRow[]
  /** Each image's link, as written, to its type and bytes. */
  images: Map<string, { mime: string; bytes: Buffer }>
}

/** Snapshots the Markdown file's local raster images; one that fails a check is left out. */
function markdownAssets(files: FileContext, root: string, markdown: CheckedFile, room: number): MarkdownImages {
  const found: MarkdownImages = { assets: [], images: new Map() }
  let left = room
  for (const link of markdownImages(markdown.bytes.toString('utf8')).slice(0, ASSETS_MAX)) {
    const rel = localImagePath(link, markdown.rel)
    if (rel === null) {
      continue
    }
    let image: CheckedFile
    try {
      image = readChecked(files, root, rel, left)
    } catch (e) {
      if (e instanceof HttpError && e.status === 413) {
        throw new HttpError(413, `${markdown.rel} and its images are larger than the 10 MB a share holds`)
      }
      continue
    }
    const mime = rasterType(image.bytes)
    if (mime === null) {
      continue
    }
    left -= image.bytes.length
    found.assets.push({ ref: link, mime, size: image.bytes.length })
    found.images.set(link, { mime, bytes: image.bytes })
  }
  return found
}

/** A frozen copy of one file, ready to store, with what the secret scan found in it. */
export interface Snapshot {
  rel: string
  real: string
  name: string
  kind: FileKind
  /** The type the download is served as: a raster, audio or video type, plain text, or bytes. */
  mime: string
  content: Buffer
  sha256: string
  /** A Markdown file's images, by the link the file names each with. */
  images: Map<string, { mime: string; bytes: Buffer }>
  assets: ShareAssetRow[]
  findings: ShareFinding[]
}

const SNIFF_BYTES = 8192

function kindOf(name: string, bytes: Buffer): FileKind {
  return kindByName(name) ?? (looksLikeText(bytes.subarray(0, SNIFF_BYTES)) ? 'text' : 'binary')
}

function safeMime(name: string, kind: FileKind, bytes: Buffer): string {
  const raster = kind === 'image' ? rasterType(bytes) : null
  if (raster !== null) {
    return raster
  }
  if (isTextKind(kind) || looksLikeText(bytes.subarray(0, SNIFF_BYTES))) {
    return 'text/plain; charset=utf-8'
  }
  return kind === 'audio' || kind === 'video' ? contentType(name, kind) : 'application/octet-stream'
}

/** Reads a file and, for Markdown, its images, through every check a share makes. */
export function takeSnapshot(files: FileContext, root: string, raw: string): Snapshot {
  const file = readChecked(files, root, raw, SHARE_MAX_BYTES)
  const kind = kindOf(file.name, file.bytes)
  const mime = safeMime(file.name, kind, file.bytes)
  const { assets, images } = rendersMarkdown(kind, file.bytes.length)
    ? markdownAssets(files, root, file, SHARE_MAX_BYTES - file.bytes.length)
    : { assets: [], images: new Map<string, { mime: string; bytes: Buffer }>() }
  const media = kind === 'image' || kind === 'audio' || kind === 'video'
  return {
    rel: file.rel,
    real: file.real,
    name: file.name,
    kind,
    mime,
    content: file.bytes,
    sha256: sha256(file.bytes),
    images,
    assets,
    findings: media && mime !== 'text/plain; charset=utf-8' ? [] : credentialFindings(file.bytes.toString('utf8')),
  }
}
