import { z } from 'zod'
import { clientSendId } from './client-send.js'
import type { TaskStatus } from './tasks.js'

export const TEAM_AUTHOR_KINDS = ['user', 'ea', 'task', 'mod'] as const
export type TeamAuthorKind = (typeof TEAM_AUTHOR_KINDS)[number]

/** Mentions that name no task: every active task, the EA, and the user. */
export const TEAM_RESERVED_HANDLES = ['all', 'ea', 'user'] as const
export type TeamReservedHandle = (typeof TEAM_RESERVED_HANDLES)[number]

export const isReservedHandle = (handle: string): handle is TeamReservedHandle =>
  (TEAM_RESERVED_HANDLES as readonly string[]).includes(handle)

export const TEAM_TEXT_MAX = 4000
export const TEAM_HANDLE_MAX = 24
export const TEAM_PAGE_MAX = 200

const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

export const teamHandle = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value) => value.replace(/^@/, ''))
  .pipe(
    z
      .string()
      .min(1, 'handle is required')
      .max(TEAM_HANDLE_MAX, `handles are at most ${String(TEAM_HANDLE_MAX)} characters`)
      .regex(HANDLE_PATTERN, 'use lowercase letters, digits and inner hyphens')
      .refine((value) => !isReservedHandle(value), 'all, ea and user are reserved'),
  )

/** A handle the text names, and the task it named when the message was posted. */
export interface TeamMention {
  handle: string
  task_id: string | null
}

/** Who a direct message is for: the EA, or an agent. */
export type TeamRecipientKind = 'ea' | 'task'

export interface TeamMessage {
  id: number
  author_kind: TeamAuthorKind
  author_task_id: string | null
  /** The author task's handle when it posted; the task may have been renamed or deleted since. */
  author_handle: string | null
  /** The mod that wrote it, when author_kind is mod. */
  author_mod_id?: string | null
  text: string
  mentions: TeamMention[]
  /** Set on a direct message, which only its author, its recipient and the user see. */
  to_kind: TeamRecipientKind | null
  /** The recipient agent; null once it is deleted, and for the EA. */
  to_task_id: string | null
  /** The recipient agent's handle when the message was posted. */
  to_handle: string | null
  created_at: string
}

export const isDirect = (message: Pick<TeamMessage, 'to_kind'>): boolean => message.to_kind !== null

/** How a direct message names its recipient: @handle or ea; null for a public message. */
export const recipientLabel = (message: Pick<TeamMessage, 'to_kind' | 'to_handle'>): string | null => {
  if (message.to_kind === null) {
    return null
  }
  return message.to_kind === 'task' ? `@${message.to_handle ?? 'agent'}` : 'ea'
}

/**
 * What a message did for one task: joined its running turn right away or at the next step,
 * started a turn, waited for the task's next turn, or was not handed over.
 */
export type TeamDeliveryMode = 'now' | 'next' | 'start' | 'held' | 'skipped'

export interface TeamDelivery {
  task_id: string
  handle: string
  mode: TeamDeliveryMode
  /** Why a message waits or was not handed over: muted, loop, burst, idle or busy. */
  reason: string | null
}

export interface TeamPosted {
  message: TeamMessage
  deliveries: TeamDelivery[]
  /** Handles in the text that name no task. */
  unknown: string[]
  /** Handles of archived agents, which get nothing until restored. */
  archived: string[]
}

export interface TeamMember {
  task_id: string
  handle: string
  title: string
  status: TaskStatus
  muted: boolean
  /** Running, holding an open session, or busy recently, so @all reaches it. */
  active: boolean
}

/** The one recipient of a direct message: an agent's @handle, or @ea. */
export const teamRecipient = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value) => value.replace(/^@/, ''))
  .pipe(
    z
      .string()
      .min(1, 'name one recipient')
      .max(TEAM_HANDLE_MAX)
      .regex(HANDLE_PATTERN, 'name one @handle')
      .refine((value) => value !== 'all', 'a direct message goes to one member, not @all')
      .refine((value) => value !== 'user', 'the user sees every message; mention @user in a public post'),
  )

export const teamPostInput = z.object({
  text: z.string().trim().min(1, 'text is required').max(TEAM_TEXT_MAX),
  /** For the EA: the message that mentioned it, so the reply reaches only the agent that asked. */
  reply_to: z.number().int().positive().optional(),
  /** Makes the post direct: only this member, the author and the user see it. */
  to: teamRecipient.optional(),
  client_id: clientSendId,
})
export type TeamPostInput = z.input<typeof teamPostInput>

export const teamMessagesQuery = z
  .object({
    after: z.coerce.number().int().min(0).optional(),
    /** The page just before this message id, for loading earlier messages. */
    before: z.coerce.number().int().min(1).optional(),
    /** A window of `limit` messages centred on this id, for a search hit far back. */
    around: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(TEAM_PAGE_MAX).default(50),
  })
  .refine((q) => q.around === undefined || (q.after === undefined && q.before === undefined), {
    message: 'Pass around on its own',
  })

/** Messages around a search hit, oldest first, and whether more lie on either side. */
export interface TeamWindow {
  messages: TeamMessage[]
  has_older: boolean
  has_newer: boolean
}

export const teamMemberInput = z
  .object({ handle: teamHandle.optional(), muted: z.boolean().optional() })
  .refine((input) => input.handle !== undefined || input.muted !== undefined, 'Pass a handle or muted')

export type TeamStreamEvent = { type: 'message'; message: TeamMessage } | { type: 'member'; member: TeamMember }

/** The folder of a task's workspace that files other agents send it land in, by sender handle. */
export const TEAM_INBOX_DIR = 'inbox'
export const TEAM_FILES_MAX = 10
export const TEAM_FILE_BYTES_MAX = 50 * 1024 * 1024
export const TEAM_FILE_NOTE_MAX = 1000

/** Who files go to: one agent's @handle, or ea, which reads them where the sender keeps them. */
const teamFileRecipient = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value) => value.replace(/^@/, ''))
  .pipe(
    z
      .string()
      .min(1, 'name one recipient')
      .max(TEAM_HANDLE_MAX)
      .regex(HANDLE_PATTERN, 'name one @handle')
      .refine((value) => value === 'ea' || !isReservedHandle(value), 'send files to one agent, or to ea'),
  )

export const teamFileInput = z.object({
  to: teamFileRecipient.describe("The receiving agent's @handle in the group chat, or ea for the EA."),
  paths: z
    .array(z.string().trim().min(1).max(4096))
    .min(1, 'name at least one file')
    .max(TEAM_FILES_MAX, `send at most ${String(TEAM_FILES_MAX)} files at once`)
    .describe('Files to send: absolute, or relative to your working directory.'),
  note: z.string().trim().max(TEAM_FILE_NOTE_MAX).optional().describe('What the files are for, in a sentence.'),
})
export type TeamFileInput = z.input<typeof teamFileInput>

/** A handoff the user or the EA starts on behalf of the agent the files come from. */
export const teamFileRequest = teamFileInput.extend({ from: z.string().trim().min(1).max(128) })
export type TeamFileRequest = z.input<typeof teamFileRequest>

export interface TeamFileCopy {
  source: string
  /** Absolute path of the copy in the receiving agent's workspace, or of the file the EA reads. */
  path: string
  bytes: number
}

export interface TeamFileSent {
  from: string
  to: string
  files: TeamFileCopy[]
  posted: TeamPosted
}

const MENTION = /(^|[^\w@./-])@([a-z0-9][a-z0-9-]*)/gi

/** Drops trailing hyphens, which end a sentence rather than a handle. */
function trimHyphens(value: string): string {
  let end = value.length
  while (end > 0 && value.charAt(end - 1) === '-') {
    end -= 1
  }
  return value.slice(0, end)
}

/** Where each @handle in the text sits, lowercased, with trailing hyphens left out. */
export function mentionSpans(text: string): { start: number; end: number; handle: string }[] {
  const spans: { start: number; end: number; handle: string }[] = []
  for (const match of text.matchAll(MENTION)) {
    const [, lead = '', raw = ''] = match
    const handle = trimHyphens(raw).toLowerCase()
    const start = match.index + lead.length
    spans.push({ start, end: start + 1 + handle.length, handle })
  }
  return spans
}

/** The handles a message mentions, lowercased, each once, in order. */
export const parseMentions = (text: string): string[] => [...new Set(mentionSpans(text).map((span) => span.handle))]

const TITLE_STOPWORDS = new Set(
  (
    'a an the to for of in on and or with from into by at is be it this that via ' +
    'fix fixes add adds make update implement feat chore refactor improve support new use remove run check ' +
    'test tests task seti'
  ).split(' '),
)

/** Handles to try for a task title, best first: its first telling word, then two words. */
export function handleCandidates(title: string): string[] {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word !== '')
  const telling = words.filter((word) => !TITLE_STOPWORDS.has(word))
  const picked = telling.length > 0 ? telling : words
  const clip = (value: string) => trimHyphens(value.slice(0, TEAM_HANDLE_MAX))
  const first = clip(picked[0] ?? 'task')
  const base = isReservedHandle(first) ? `${first}-task` : first
  const second = picked[1]
  return [...new Set([base, ...(second === undefined ? [] : [clip(`${base}-${second}`)])])]
}
