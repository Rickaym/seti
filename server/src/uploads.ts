import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  ATTACHMENT_FILE_MAX,
  ATTACHMENT_MESSAGE_MAX,
  attachmentReference,
  formatBytes,
  lineCount,
  UPLOADS_DIR,
  type AttachmentRef,
  type PromptAttachment,
  type StagedUpload,
  type UploadQuery,
} from '@seti/shared'
import { audit } from './audit.js'
import { SETI_HOME } from './config.js'
import { tasks } from './db.js'
import { HttpError } from './http.js'
import { extensionOf, showable, sniff, SNIFF_BYTES } from './upload-sniff.js'
import { workspaceDir } from './workspace/dir.js'
import { moveInto } from './workspace/files.js'

const STAGING = path.join(SETI_HOME, 'uploads')
/** A draft keeps its attachments this long; the composer saves them with the draft. */
const STAGED_TTL_MS = 24 * 60 * 60 * 1000
const NAME_MAX = 100

const dataFile = (id: string) => path.join(STAGING, id)
const metaFile = (id: string) => path.join(STAGING, `${id}.json`)

function sweep(now = Date.now()): void {
  for (const entry of fs.readdirSync(STAGING, { withFileTypes: true })) {
    const file = path.join(STAGING, entry.name)
    const stat = fs.statSync(file, { throwIfNoEntry: false })
    if (stat !== undefined && now - stat.mtimeMs > STAGED_TTL_MS) {
      fs.rmSync(file, { force: true })
    }
  }
}

function capped(name: string): Transform {
  let seen = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length
      if (seen > ATTACHMENT_FILE_MAX) {
        done(new HttpError(413, `${name} is over the ${formatBytes(ATTACHMENT_FILE_MAX)} limit for one file`))
        return
      }
      done(null, chunk)
    },
  })
}

function readHead(file: string): Buffer {
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(SNIFF_BYTES)
    return head.subarray(0, fs.readSync(fd, head, 0, SNIFF_BYTES, 0))
  } finally {
    fs.closeSync(fd)
  }
}

/** A name safe on any filesystem and in a shell: no folders, no leading dot, no odd characters. */
export function safeName(name: string, ext: string | null): string {
  const base = name.split(/[/\\]/).pop() ?? ''
  const clean = base
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+/, '')
  const known = extensionOf(clean)
  const stem = known === '' ? clean : clean.slice(0, clean.length - known.length - 1)
  const suffix = known === '' ? (ext ?? '') : known
  const trimmed = stem.endsWith('-') || stem.endsWith('.') ? stem.slice(0, -1) : stem
  const kept = (trimmed === '' ? 'file' : trimmed).slice(0, NAME_MAX - suffix.length - 1)
  return suffix === '' ? kept : `${kept}.${suffix}`
}

/** Streams an upload to the staging folder, capped, then sniffs what it is. */
export async function stageUpload(body: ReadableStream<Uint8Array> | null, query: UploadQuery): Promise<StagedUpload> {
  fs.mkdirSync(STAGING, { recursive: true, mode: 0o700 })
  sweep()
  const id = randomUUID()
  const file = dataFile(id)
  const source = query.source ?? 'file'
  try {
    await pipeline(
      body === null ? Readable.from([]) : Readable.fromWeb(body),
      capped(query.name),
      fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }),
    )
    const size = fs.statSync(file).size
    if (size === 0) {
      throw new HttpError(400, `${query.name} is empty`)
    }
    const read = () => fs.readFileSync(file, 'utf8')
    const sniffed = sniff(readHead(file), query.name, source === 'paste', read)
    const staged: StagedUpload = {
      id,
      name: source === 'paste' ? `paste.${sniffed.ext ?? 'txt'}` : safeName(query.name, sniffed.ext),
      source,
      kind: sniffed.kind,
      type: sniffed.type,
      mime: sniffed.mime,
      size,
      lines: sniffed.kind === 'text' ? lineCount(read()) : null,
      shown: sniffed.kind === 'image' && showable(sniffed, size),
    }
    fs.writeFileSync(metaFile(id), JSON.stringify(staged), { mode: 0o600 })
    return staged
  } catch (e) {
    fs.rmSync(file, { force: true })
    throw e
  }
}

export function stagedUpload(id: string): StagedUpload | null {
  try {
    return JSON.parse(fs.readFileSync(metaFile(id), 'utf8')) as StagedUpload
  } catch {
    return null
  }
}

export const stagedPath = (id: string) => dataFile(id)

export function removeStaged(id: string): void {
  fs.rmSync(dataFile(id), { force: true })
  fs.rmSync(metaFile(id), { force: true })
}

/** Slash and shell commands run as typed, so files cannot go with them. */
export function refuseCommandAttachments(prompt: string, refs: readonly AttachmentRef[]): void {
  if (refs.length > 0 && /^[/!]/.test(prompt.trimStart())) {
    throw new HttpError(400, 'Attachments go with messages, not with commands')
  }
}

/** A message's staged uploads; refused whole when one is gone or they are too big together. */
export function checkStaged(refs: readonly AttachmentRef[]): StagedUpload[] {
  const staged = refs.map((ref) => {
    const found = stagedUpload(ref.id)
    if (found === null) {
      throw new HttpError(400, 'An attachment expired or was removed; attach it again')
    }
    return found
  })
  const total = staged.reduce((sum, file) => sum + file.size, 0)
  if (total > ATTACHMENT_MESSAGE_MAX) {
    throw new HttpError(413, `Attachments are limited to ${formatBytes(ATTACHMENT_MESSAGE_MAX)} a message`)
  }
  return staged
}

const pad = (n: number) => String(n).padStart(2, '0')

const stamp = (at: Date) =>
  `${String(at.getFullYear())}${pad(at.getMonth() + 1)}${pad(at.getDate())}-` +
  `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`

/** Pastes are named by when they were sent, since their text has no name of its own. */
const pasteName = (at: Date, n: number, name: string) => `${stamp(at)}-${String(n)}.${extensionOf(name)}`

/** Puts each reference where its token is in the prompt, or after it when the token is gone. */
function substitute(prompt: string, tokens: readonly string[], references: readonly string[]): string {
  let text = prompt
  const appended: string[] = []
  tokens.forEach((token, i) => {
    const reference = references[i] ?? ''
    const at = text.indexOf(token)
    if (at < 0) {
      appended.push(reference)
    } else {
      text = text.slice(0, at) + reference + text.slice(at + token.length)
    }
  })
  return appended.length === 0 ? text : [text, ...appended].filter((part) => part.trim() !== '').join('\n\n')
}

/** Moves staged uploads into the workspace, which the sandbox mounts at the same path. */
export async function placeAttachments(
  taskId: string,
  prompt: string,
  refs: readonly AttachmentRef[],
  at = new Date(),
): Promise<{ prompt: string; attachments: PromptAttachment[] }> {
  if (refs.length === 0) {
    return { prompt, attachments: [] }
  }
  const staged = checkStaged(refs)
  const root = workspaceDir(taskId)
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  let pastes = 0
  const attachments = staged.map((file): PromptAttachment => {
    pastes += file.source === 'paste' ? 1 : 0
    const name = file.source === 'paste' ? pasteName(at, pastes, file.name) : file.name
    const rel = moveInto(root, path.join(UPLOADS_DIR, name), stagedPath(file.id))
    removeStaged(file.id)
    const where = path.join(root, rel)
    const { kind, type, mime, size, lines, shown } = file
    const reference = attachmentReference(where, file)
    return { path: where, name: path.basename(rel), kind, type, mime, size, lines, shown, reference }
  })
  await auditAttachments(taskId, attachments)
  const text = substitute(
    prompt,
    refs.map((ref) => ref.token),
    attachments.map((file) => file.reference),
  )
  return { prompt: text, attachments }
}

async function auditAttachments(taskId: string, files: readonly PromptAttachment[]): Promise<void> {
  const title = (await tasks.get(taskId))?.title ?? taskId
  const total = files.reduce((sum, file) => sum + file.size, 0)
  const count = `${String(files.length)} ${files.length === 1 ? 'file' : 'files'}`
  await audit.record({
    actor: 'user',
    kind: 'task.files_attached',
    subject_type: 'task',
    subject_id: taskId,
    summary: `Attached ${count} (${formatBytes(total)}) to task "${title}"`,
    detail: {
      title,
      count: files.length,
      bytes: total,
      files: files.map((file) => `${file.name} (${file.type}, ${formatBytes(file.size)})`),
    },
  })
}
