import {
  detectTextType,
  lineCount,
  type AttachmentKind,
  type AttachmentRef,
  type StagedUpload,
  type UploadSource,
} from '@seti/shared'
import { RequestError, SIGN_IN_REQUIRED, streamUrl } from '@/api'

/** A file in a draft: shown as a chip, uploaded as soon as it is added, sent by its token. */
export interface DraftAttachment {
  key: string
  /** Stands for the file in the draft text until the message goes out. */
  token: string
  name: string
  kind: AttachmentKind
  type: string
  size: number
  lines: number | null
  /** Null while it uploads. */
  staged: StagedUpload | null
  /** The pasted text, kept in memory to put back inline without asking the server. */
  text?: string
  /** A local object URL of an image, until the upload can show it. */
  preview?: string
}

const STORAGE_PREFIX = 'seti.draft-files.'

/** Uploaded attachments kept with a draft across reloads; the server keeps their files a day. */
export const attachmentStore = {
  read: (key: string): DraftAttachment[] => {
    try {
      const saved = localStorage.getItem(STORAGE_PREFIX + key)
      return saved === null ? [] : (JSON.parse(saved) as DraftAttachment[])
    } catch {
      return []
    }
  },
  write: (key: string, items: readonly DraftAttachment[]): void => {
    const kept = items.flatMap((item) =>
      item.staged === null ? [] : [{ ...item, text: undefined, preview: undefined }],
    )
    try {
      if (kept.length === 0) {
        localStorage.removeItem(STORAGE_PREFIX + key)
      } else {
        localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(kept))
      }
    } catch {
      return
    }
  },
}

export const stagedUrl = (id: string) => streamUrl(`/uploads/${id}`)

/** Streams one file to the server as the request body, which sniffs and stages it. */
export async function uploadFile(body: Blob, name: string, source: UploadSource): Promise<StagedUpload> {
  const query = new URLSearchParams({ name, source })
  const res = await fetch(streamUrl(`/uploads?${query.toString()}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  })
  if (res.status === 401) {
    window.dispatchEvent(new Event(SIGN_IN_REQUIRED))
  }
  const envelope = (await res.json().catch(() => null)) as {
    data?: StagedUpload
    error?: { detail: string }
  } | null
  if (!res.ok || envelope?.data === undefined) {
    throw new RequestError(res.status, envelope?.error?.detail ?? `Upload failed (${String(res.status)})`)
  }
  return envelope.data
}

const splitName = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
}

/** `name`, or `name-2`, `name-3` when the draft already has a file of that name. */
export function uniqueName(name: string, taken: readonly string[]): string {
  const [stem, ext] = splitName(name)
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? name : `${stem ?? name}-${String(n)}${ext ?? ''}`
    if (!taken.includes(candidate)) {
      return candidate
    }
  }
}

const tokenFor = (name: string) => `[${name}]`

const pasteNumber = (taken: readonly string[]) =>
  Math.max(0, ...taken.map((name) => Number(/^paste-(\d+)\./.exec(name)?.[1] ?? 0))) + 1

/** A chip for pasted text before its upload finishes, named paste-N with its detected type. */
export function pasteAttachment(text: string, taken: readonly string[]): DraftAttachment {
  const type = detectTextType(text)
  const name = `paste-${String(pasteNumber(taken))}.${type.ext}`
  return {
    key: crypto.randomUUID(),
    token: tokenFor(name),
    name,
    kind: 'text',
    type: type.label,
    size: new Blob([text]).size,
    lines: lineCount(text),
    staged: null,
    text,
  }
}

export function fileAttachment(file: File, taken: readonly string[]): DraftAttachment {
  const name = uniqueName(file.name === '' ? 'file' : file.name.replace(/[[\]\s]+/g, '-'), taken)
  const image = file.type.startsWith('image/')
  return {
    key: crypto.randomUUID(),
    token: tokenFor(name),
    name,
    kind: image ? 'image' : 'file',
    type: file.type === '' ? 'File' : file.type,
    size: file.size,
    lines: null,
    staged: null,
    ...(image ? { preview: URL.createObjectURL(file) } : {}),
  }
}

/** The uploads a message carries, with their tokens put back in when the text lost them. */
export function outgoing(
  text: string,
  items: readonly DraftAttachment[],
): { prompt: string; attachments?: AttachmentRef[] } {
  const ready = items.flatMap((item) => (item.staged === null ? [] : [{ id: item.staged.id, token: item.token }]))
  if (ready.length === 0) {
    return { prompt: text }
  }
  const missing = ready.filter((ref) => !text.includes(ref.token)).map((ref) => ref.token)
  const prompt = [text.trimEnd(), missing.join(' ')].filter((part) => part !== '').join('\n\n')
  return { prompt, attachments: ready }
}

/** The draft with a token taken out, and the space that was put in after it. */
export function withoutToken(text: string, token: string): string {
  const at = text.indexOf(token)
  if (at < 0) {
    return text
  }
  const before = text.slice(0, at)
  const after = text.slice(at + token.length)
  const joined = /(^|\s)$/.test(before) && after.startsWith(' ') ? before + after.slice(1) : before + after
  return joined.trim() === '' ? '' : joined
}

/** The draft with the token replaced by the text it stands for, or the text added at the end. */
export function withInline(text: string, token: string, inline: string): string {
  const at = text.indexOf(token)
  if (at < 0) {
    return text === '' ? inline : `${text}\n${inline}`
  }
  return text.slice(0, at) + inline + text.slice(at + token.length)
}

/** The draft with tokens added at its end, for files attached with the button. */
export const withTokens = (text: string, tokens: readonly string[]) =>
  tokens.length === 0 ? text : [text.trimEnd(), tokens.join(' ')].filter((part) => part !== '').join(' ')
