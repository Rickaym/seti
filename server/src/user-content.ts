import path from 'node:path'
import type { PromptAttachment } from '@seti/shared'
import type { InputContent } from './runtimes/adapter.js'
import { SHOWN_MIMES } from './upload-sniff.js'
import { workspaceDir } from './workspace/dir.js'
import { readBytes } from './workspace/files.js'

type ShownMime = (typeof SHOWN_MIMES)[number]
const isShownMime = (mime: string): mime is ShownMime => (SHOWN_MIMES as readonly string[]).includes(mime)

/** The message the agent gets: the text, then its images, read again from the workspace. */
export function userContent(taskId: string, text: string, attachments: readonly PromptAttachment[]): InputContent {
  const root = workspaceDir(taskId)
  const images = attachments.flatMap((file): InputContent['images'] => {
    const { mime } = file
    const data = file.shown && isShownMime(mime) ? readBytes(root, path.relative(root, file.path)) : null
    return data === null || !isShownMime(mime) ? [] : [{ mime, data: data.toString('base64') }]
  })
  return { text, images }
}
