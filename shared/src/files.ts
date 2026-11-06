import { z } from 'zod'
import { Registry } from './registry.js'

/** The largest file the editor loads or saves; bigger text files are only shown raw or downloaded. */
export const FILE_TEXT_MAX = 2 * 1024 * 1024

export const FILE_LIST_MAX = 2000

export const FILE_RECENT_MAX = 200

export const FILE_RESOLVE_MAX = 100

/** Folders a recent-files walk skips; browsing into them still works. */
export const NOISE_DIRS = [
  '.git',
  'node_modules',
  '.venv',
  'dist',
  'build',
  '.next',
  '.cache',
  '__pycache__',
  'target',
] as const

export type FileRootKind = 'cwd' | 'repo' | 'dir' | 'workspace'

/** A directory of a task that the Files view browses. */
export interface FileRoot {
  id: string
  label: string
  /** Absolute path as the task names it. */
  path: string
  kind: FileRootKind
  exists: boolean
  /** The user can save text files here; the workspace mirrors Seti's own data and is read-only. */
  writable: boolean
}

export type FileEntryType = 'file' | 'dir'

export interface FileEntry {
  name: string
  /** Relative to the root, with forward slashes. */
  path: string
  type: FileEntryType
  size: number
  mtime: string
}

export interface FileListing {
  root: string
  path: string
  entries: FileEntry[]
  /** More entries than FILE_LIST_MAX; the newest or first by name were kept. */
  truncated: boolean
}

export interface RecentFile extends FileEntry {
  root: string
}

export interface RecentFiles {
  files: RecentFile[]
  since: string
  /** A root held more than one walk looks at, so older changes there may be missing. */
  truncated: boolean
}

/** Mermaid and csv files are text the editor opens; spreadsheets are binary workbooks. */
export type FileKind =
  'markdown' | 'mermaid' | 'csv' | 'text' | 'spreadsheet' | 'pdf' | 'image' | 'audio' | 'video' | 'binary'

export const isTextKind = (kind: FileKind) =>
  kind === 'text' || kind === 'markdown' || kind === 'mermaid' || kind === 'csv'

/** What the viewer needs to pick how to show a file, and what the editor saves against. */
export interface FileMeta {
  root: string
  path: string
  name: string
  size: number
  mtime: string
  kind: FileKind
  content_type: string
  /** sha256 of the content for text files up to FILE_TEXT_MAX, else null. */
  hash: string | null
  writable: boolean
}

export interface FileText extends FileMeta {
  text: string
}

/** A file's state now, as the change stream reports it. */
export interface FileStamp {
  exists: boolean
  size: number
  mtime: string | null
  hash: string | null
}

/** The body of a 409 for a save whose base no longer matches the file on disk. */
export interface FileConflict {
  error: { title: string; detail: string }
  current: FileStamp
}

export interface ResolvedPath {
  input: string
  root: string
  path: string
  type: FileEntryType
  /** Set when the path is in another task, whose Files view opens it. */
  task_id?: string
  /** A file's size in bytes and its last change; left out for a folder. */
  size?: number
  mtime?: string
}

/** The task, root and path a link to a file's bytes names. */
export interface FileUrlTarget {
  task_id: string
  root: string
  path: string
}

const RAW_FILE_URL = /^(?:https?:\/\/[^/\s?#]+)?\/api\/tasks\/[^/\s?#]+\/files\/raw\?\S*$/i
const RAW_FILE_PATH = /^\/api\/tasks\/([^/]+)\/files\/raw$/
const SOME_ORIGIN = 'https://seti.invalid'

/** A file or folder a Files deep link opens in its task's Files view. */
export interface FilesLink {
  task_id: string
  root: string
  path: string
  type: FileEntryType
}

/** The hash of a Files deep link: `agents/<task>/files/<root>/<path>`, a folder ending in `/`. */
export function filesLinkHash({ task_id, root, path, type }: FilesLink): string {
  const segments = path.split('/').filter((part) => part !== '')
  const tail = segments.map(encodeURIComponent).join('/')
  const folder = type === 'dir' && tail !== '' ? '/' : ''
  return `agents/${encodeURIComponent(task_id)}/files/${encodeURIComponent(root)}/${tail}${folder}`
}

const FILES_HASH = /^#?\/?agents\/([^/?#\s]+)\/files\/([^/?#\s]+)\/([^?#\s]*)$/

const decoded = (part: string): string | null => {
  try {
    return decodeURIComponent(part)
  } catch {
    return null
  }
}

/** The file or folder a Files deep link hash opens; null for any other hash. */
export function filesLinkOfHash(hash: string): FilesLink | null {
  const match = FILES_HASH.exec(hash.trim())
  if (match === null) {
    return null
  }
  const [, task = '', root = '', rest = ''] = match
  const parts = rest
    .split('/')
    .filter((part) => part !== '')
    .map(decoded)
  const id = decoded(task)
  const rootId = decoded(root)
  if (id === null || rootId === null || parts.some((part) => part === null || part === '..' || part === '.')) {
    return null
  }
  return { task_id: id, root: rootId, path: parts.join('/'), type: rest === '' || rest.endsWith('/') ? 'dir' : 'file' }
}

const FILES_LINK_URL = /^(?:https?:\/\/[^/\s?#]+)?\/?#\/?agents\/[^/\s?#]+\/files\//i

/** The file a Files link names on any host: a deep link, or a `files/raw` download link. */
export function fileUrlTarget(raw: string): FileUrlTarget | null {
  const text = raw.trim()
  if (FILES_LINK_URL.test(text) && URL.canParse(text, SOME_ORIGIN)) {
    const link = filesLinkOfHash(new URL(text, SOME_ORIGIN).hash)
    return link === null || link.path === '' ? null : { task_id: link.task_id, root: link.root, path: link.path }
  }
  if (!RAW_FILE_URL.test(text) || !URL.canParse(text, SOME_ORIGIN)) {
    return null
  }
  const url = new URL(text, SOME_ORIGIN)
  const task = RAW_FILE_PATH.exec(url.pathname)?.[1]
  const root = url.searchParams.get('root') ?? ''
  const path = url.searchParams.get('path') ?? ''
  if (task === undefined || root === '' || path === '') {
    return null
  }
  return { task_id: decodeURIComponent(task), root, path }
}

const flag = z
  .enum(['0', '1', 'true', 'false'])
  .optional()
  .transform((value) => value === '1' || value === 'true')

const relPath = z.string().max(4096).default('')

export const fileQuery = z.object({
  root: z.string().min(1).max(64),
  path: relPath,
  /** Opt in to dot files and folders such as .env; hidden paths stay refused. */
  dotfiles: flag,
})
export type FileQuery = z.output<typeof fileQuery>

export const FILE_SORTS = ['recent', 'name'] as const
export type FileSort = (typeof FILE_SORTS)[number]

/** Opt in to the files Seti writes into the workspace, such as members.md, which change often. */
const setiFiles = flag

export const fileListQuery = fileQuery.extend({ sort: z.enum(FILE_SORTS).default('recent'), seti_files: setiFiles })
export type FileListQuery = z.output<typeof fileListQuery>

export const fileRawQuery = fileQuery.extend({
  download: flag,
  /** An HTML file as a page in a sandbox with no network, for the viewer's frame; else ignored. */
  preview: flag,
  /** With preview, let the page run its inline scripts, still with no network. */
  scripts: flag,
})

export const recentFilesQuery = z.object({
  /** Files changed in the last this many days; by default, since the task started. */
  days: z.coerce.number().int().min(1).max(365).optional(),
  limit: z.coerce.number().int().min(1).max(FILE_RECENT_MAX).default(50),
  seti_files: setiFiles,
})

export const resolvePathsQuery = z.object({
  p: z
    .union([z.string(), z.array(z.string())])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .pipe(z.array(z.string().min(1).max(1024)).max(FILE_RESOLVE_MAX)),
})

/** The most hits one files search returns. */
export const FILE_SEARCH_MAX = 200

/** name: fuzzy match on paths; text: the query inside files. */
export const FILE_SEARCH_MODES = ['name', 'text'] as const
export type FileSearchMode = (typeof FILE_SEARCH_MODES)[number]

export const fileSearchQuery = z.object({
  q: z.string().trim().min(1, 'Type something to search for').max(200),
  mode: z.enum(FILE_SEARCH_MODES).default('name'),
  /** Text search only: read the query as a regular expression instead of literal text. */
  regex: flag,
  dotfiles: flag,
  seti_files: setiFiles,
  limit: z.coerce.number().int().min(1).max(FILE_SEARCH_MAX).default(FILE_SEARCH_MAX),
})
export type FileSearchQuery = z.output<typeof fileSearchQuery>

/** A file or folder whose path matched; `marks` are the matched character indexes of `path`. */
export interface FileNameHit {
  root: string
  path: string
  type: FileEntryType
  marks: number[]
}

/** A line that held the query; `marks` are [start, end) character ranges of `text`. */
export interface FileTextHit {
  root: string
  path: string
  line: number
  text: string
  marks: [number, number][]
}

interface FileSearchBase {
  /** More matched than the limit; the best or first ones were kept. */
  truncated: boolean
  /** The search ran out of time or room, so some files were not looked at. */
  partial: boolean
}

export type FileSearch =
  (FileSearchBase & { mode: 'name'; hits: FileNameHit[] }) | (FileSearchBase & { mode: 'text'; hits: FileTextHit[] })

export const saveFileInput = z.object({
  root: z.string().min(1).max(64),
  path: z.string().min(1).max(4096),
  text: z.string().max(FILE_TEXT_MAX),
  /** The hash the editor loaded, or null to create a file that must not exist yet. */
  base_hash: z.string().max(128).nullable(),
  dotfiles: z.boolean().default(false),
})
export type SaveFileInput = z.input<typeof saveFileInput>

const EXTENSION_KINDS: Record<string, FileKind> = {
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  mmd: 'mermaid',
  mermaid: 'mermaid',
  csv: 'csv',
  tsv: 'csv',
  xlsx: 'spreadsheet',
  xlsm: 'spreadsheet',
  xls: 'spreadsheet',
  ods: 'spreadsheet',
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  bmp: 'image',
  ico: 'image',
  svg: 'image',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  oga: 'audio',
  opus: 'audio',
  m4a: 'audio',
  aac: 'audio',
  flac: 'audio',
  mp4: 'video',
  m4v: 'video',
  webm: 'video',
  mov: 'video',
  mkv: 'video',
  ogv: 'video',
}

export const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** The largest file Seti serves as a sandboxed page; bigger ones only download. */
export const HTML_PREVIEW_MAX = 20 * 1024 * 1024

/** An extension a mod's file viewer adds, and whether Seti reads such files as text. */
export interface ExtensionKind {
  extension: string
  kind: 'text' | 'binary'
  /** The viewer that shows it, as `<mod>.<viewer>`. */
  viewer: string
}

/** Extensions mods add beside Seti's own, which no mod can take over. */
export const extensionKinds = new Registry<ExtensionKind>('file extension', (entry) => entry.extension)

/** Whether Seti itself knows the extension, so no mod may claim it. */
export const isCoreExtension = (extension: string) => Object.hasOwn(EXTENSION_KINDS, extension)

/** The kind a file name says, or null when only the content can tell text from binary. */
export const kindByName = (name: string): FileKind | null => {
  const extension = extensionOf(name)
  return isCoreExtension(extension)
    ? (EXTENSION_KINDS[extension] ?? null)
    : (extensionKinds.get(extension)?.kind ?? null)
}
