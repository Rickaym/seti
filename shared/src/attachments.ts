import { z } from 'zod'

/** About 1k tokens at 4 characters each, or 30 lines; Claude Code folds 800 only on screen. */
export const PASTE_FILE_CHARS = 4000
export const PASTE_FILE_LINES = 30

/** A file the agent should open, not a message: 25 MB each, 50 MB and 20 files a message. */
export const ATTACHMENT_FILE_MAX = 25 * 1024 * 1024
export const ATTACHMENT_MESSAGE_MAX = 50 * 1024 * 1024
export const ATTACHMENTS_PER_MESSAGE = 20

/** The workspace folder attachments land in, next to chat.md and the other workspace files. */
export const UPLOADS_DIR = 'uploads'

export function lineCount(text: string): number {
  if (text === '') {
    return 0
  }
  const breaks = text.match(/\n/g)?.length ?? 0
  return text.endsWith('\n') ? breaks : breaks + 1
}

export const pasteGoesToFile = (text: string) => text.length > PASTE_FILE_CHARS || lineCount(text) >= PASTE_FILE_LINES

/** `paste` is text the composer made into a file; `file` is one picked, dropped or pasted. */
export const uploadSource = z.enum(['paste', 'file'])
export type UploadSource = z.infer<typeof uploadSource>

export const uploadQuery = z.object({
  name: z.string().trim().min(1).max(255),
  source: uploadSource.default('file'),
})
export type UploadQuery = z.input<typeof uploadQuery>

export const uploadParams = z.object({ id: z.uuid() })

/** `text` files are named by their detected type; `image` ones the model can also see. */
export type AttachmentKind = 'text' | 'image' | 'file'

/** A file uploaded for a message that is not sent yet. */
export interface StagedUpload {
  id: string
  /** The name it came with; pastes get `paste.<ext>`. */
  name: string
  source: UploadSource
  kind: AttachmentKind
  /** What it is, for people: JSON, Python, PNG image, PDF. */
  type: string
  /** From the content, not the name. */
  mime: string
  size: number
  /** Text files only. */
  lines: number | null
  /** Images the model sees with the message, not only as a path. */
  shown: boolean
}

/** A staged upload sent with a message, and the text in the message that stands for it. */
export const attachmentRef = z.object({ id: z.uuid(), token: z.string().min(1).max(300) })
export type AttachmentRef = z.infer<typeof attachmentRef>

export const attachmentRefs = z
  .array(attachmentRef)
  .max(ATTACHMENTS_PER_MESSAGE, `send at most ${String(ATTACHMENTS_PER_MESSAGE)} attachments at once`)
  .refine((refs) => new Set(refs.map((ref) => ref.id)).size === refs.length, 'an attachment can only be sent once')
  .default([])

/** An attachment of a sent message, as the agent's workspace holds it. */
export interface PromptAttachment {
  path: string
  name: string
  kind: AttachmentKind
  type: string
  mime: string
  size: number
  lines: number | null
  shown: boolean
  /** The text in the prompt that points the agent to the file. */
  reference: string
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`
  }
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = value < 10 ? 1 : 0
  return `${value.toFixed(digits)} ${units[unit] ?? 'GB'}`
}

const LINES = new Intl.NumberFormat('en-US')

export const formatLines = (lines: number) => `${LINES.format(lines)} ${lines === 1 ? 'line' : 'lines'}`

export function attachmentDetail(file: Pick<StagedUpload, 'type' | 'size' | 'lines'>): string {
  return [file.type, ...(file.lines === null ? [] : [formatLines(file.lines)]), formatBytes(file.size)].join(', ')
}

/** What the agent reads where the attachment was: its path, with what it is. */
export function attachmentReference(
  path: string,
  file: Pick<StagedUpload, 'source' | 'kind' | 'type' | 'size' | 'lines' | 'shown'>,
): string {
  const detail = attachmentDetail(file)
  if (file.source === 'paste') {
    return `Pasted as ${path} (${detail})`
  }
  if (file.kind !== 'image') {
    return `Attached ${path} (${detail})`
  }
  return file.shown
    ? `Attached ${path} (${detail}; the image follows this message)`
    : `Attached ${path} (${detail}; too large to show here, Read the file to see it)`
}
