import path from 'node:path'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { PromptAttachment } from '@seti/shared'
import { SHOWN_MIMES } from './upload-sniff.js'
import { workspaceDir } from './workspace/dir.js'
import { readBytes } from './workspace/files.js'

/** What a user message to Claude Code holds: text, or text and images. */
export type UserContent = SDKUserMessage['message']['content']
type ContentBlock = Exclude<UserContent, string>[number]

type ShownMime = (typeof SHOWN_MIMES)[number]
const isShownMime = (mime: string): mime is ShownMime => (SHOWN_MIMES as readonly string[]).includes(mime)

/** The message the agent gets: the text, then its images, read again from the workspace. */
export function userContent(taskId: string, text: string, attachments: readonly PromptAttachment[]): UserContent {
  const root = workspaceDir(taskId)
  const images = attachments.flatMap((file): ContentBlock[] => {
    const { mime } = file
    const data = file.shown && isShownMime(mime) ? readBytes(root, path.relative(root, file.path)) : null
    return data === null || !isShownMime(mime)
      ? []
      : [{ type: 'image', source: { type: 'base64', media_type: mime, data: data.toString('base64') } }]
  })
  return images.length === 0 ? text : [{ type: 'text', text }, ...images]
}
