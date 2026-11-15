import {
  ATTACHMENT_FILE_MAX,
  ATTACHMENT_MESSAGE_MAX,
  ATTACHMENTS_PER_MESSAGE,
  SHARE_HASH,
} from '@seti/shared/attachment-limits'

/** Holds the one share waiting for the Share page, on this device only; a new share replaces it. */
export const SHARE_CACHE = 'seti-share-inbox'

const MANIFEST = '/share-inbox/manifest'
const fileKey = (index: number) => `/share-inbox/files/${String(index)}`

interface SharedFileInfo {
  /** Where the file sits in the inbox. */
  index: number
  name: string
  type: string
  size: number
}

/** A shared file the inbox did not keep, and why. */
export interface LeftFile {
  name: string
  size: number
  reason: string
}

export interface ShareManifest {
  id: string
  title: string
  text: string
  url: string
  files: SharedFileInfo[]
  left: LeftFile[]
}

interface SharedFile {
  info: SharedFileInfo
  file: File
}

export interface Share {
  manifest: ShareManifest
  files: SharedFile[]
}

const MB = 1024 * 1024

/** Why a file cannot go with the message under the attachment limits, or null when it can. */
function refusal(size: number, kept: number, total: number): string | null {
  if (size > ATTACHMENT_FILE_MAX) {
    return `larger than ${String(ATTACHMENT_FILE_MAX / MB)} MB`
  }
  if (kept >= ATTACHMENTS_PER_MESSAGE) {
    return `more than ${String(ATTACHMENTS_PER_MESSAGE)} files`
  }
  return total + size > ATTACHMENT_MESSAGE_MAX ? `over ${String(ATTACHMENT_MESSAGE_MAX / MB)} MB in all` : null
}

/** The files that fit one message's attachment limits, in order, and why each other one does not. */
export function fitLimits(files: readonly { name: string; size: number }[]): { kept: number[]; left: LeftFile[] } {
  const kept: number[] = []
  const left: LeftFile[] = []
  let total = 0
  files.forEach((file, index) => {
    const reason = refusal(file.size, kept.length, total)
    if (reason === null) {
      kept.push(index)
      total += file.size
    } else {
      left.push({ name: file.name, size: file.size, reason })
    }
  })
  return { kept, left }
}

const field = (form: FormData, name: string) => {
  const value = form.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/** Android sends an empty, nameless file when a share carries only text. */
const sharedFiles = (form: FormData) =>
  form
    .getAll('files')
    .filter((value): value is File => typeof value !== 'string' && (value.size > 0 || value.name !== ''))

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })

/** Keeps a posted share in the inbox in place of any earlier one, then sends the page to it. */
export async function receiveShare(request: Request, storage: CacheStorage, id: string): Promise<Response> {
  const page = new URL(`/${SHARE_HASH}`, request.url).href
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return Response.redirect(page, 303)
  }
  const files = sharedFiles(form)
  const { kept, left } = fitLimits(files)
  await storage.delete(SHARE_CACHE)
  const cache = await storage.open(SHARE_CACHE)
  const infos = kept.flatMap((at, index) => {
    const file = files[at]
    return file === undefined
      ? []
      : [{ index, file, info: { index, name: file.name, type: file.type, size: file.size } }]
  })
  await Promise.all(infos.map(async ({ index, file }) => cache.put(fileKey(index), new Response(file))))
  const manifest: ShareManifest = {
    id,
    title: field(form, 'title'),
    text: field(form, 'text'),
    url: field(form, 'url'),
    files: infos.map(({ info }) => info),
    left,
  }
  await cache.put(MANIFEST, json(manifest))
  return Response.redirect(page, 303)
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isManifest = (value: unknown): value is ShareManifest =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  ['title', 'text', 'url'].every((key) => typeof value[key] === 'string') &&
  Array.isArray(value.files) &&
  Array.isArray(value.left)

async function manifestOf(cache: Cache): Promise<ShareManifest | null> {
  const stored = await cache.match(MANIFEST)
  const value: unknown = await stored?.json().catch(() => null)
  return isManifest(value) ? value : null
}

/** The share waiting in the inbox with its files, or null when none waits. */
export async function readShare(storage: CacheStorage): Promise<Share | null> {
  if (!(await storage.has(SHARE_CACHE))) {
    return null
  }
  const cache = await storage.open(SHARE_CACHE)
  const manifest = await manifestOf(cache)
  if (manifest === null) {
    return null
  }
  const files = await Promise.all(
    manifest.files.map(async (info): Promise<SharedFile | null> => {
      const body = await cache.match(fileKey(info.index))
      return body === undefined ? null : { info, file: new File([await body.blob()], info.name, { type: info.type }) }
    }),
  )
  return { manifest, files: files.filter((file) => file !== null) }
}

/** Takes one file out of the waiting share, so a reload does not bring it back. */
export async function dropSharedFile(storage: CacheStorage, index: number): Promise<void> {
  if (!(await storage.has(SHARE_CACHE))) {
    return
  }
  const cache = await storage.open(SHARE_CACHE)
  const manifest = await manifestOf(cache)
  if (manifest === null) {
    return
  }
  await cache.put(MANIFEST, json({ ...manifest, files: manifest.files.filter((info) => info.index !== index) }))
  await cache.delete(fileKey(index))
}

/** Forgets the waiting share and its files. */
export async function clearShare(storage: CacheStorage): Promise<void> {
  await storage.delete(SHARE_CACHE)
}
