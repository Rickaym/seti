import { z } from 'zod'
import type { Task } from './tasks.js'

/** What a rewind puts back: the conversation, the files the agent edited, or both. */
export const REWIND_RESTORES = ['conversation', 'code', 'both'] as const
export type RewindRestore = (typeof REWIND_RESTORES)[number]

/** Pending until a turn starts from it; refused when Claude Code declines the truncated resume. */
export const REWIND_STATES = ['pending', 'applied', 'refused', 'superseded'] as const
export type RewindState = (typeof REWIND_STATES)[number]

export const rewindInput = z.object({
  message_id: z.number().int().positive(),
  restore: z.enum(REWIND_RESTORES).default('conversation'),
})
export type RewindInput = z.input<typeof rewindInput>

export const rewindFilesQuery = z.object({
  message_id: z.coerce.number().int().positive(),
})

/** One rewind of a task, kept after it applies so the transcript can mark what it dropped. */
export interface TaskRewind {
  id: number
  task_id: string
  /** The prompt row the task went back to; it and every row up to last_message_id are rewound. */
  prompt_message_id: number
  last_message_id: number
  /** Prompts, shell runs and top-level agent messages in the rewound rows. */
  message_count: number
  prompt_text: string
  restore: RewindRestore
  state: RewindState
  /** Why Claude Code refused it, for the refused state. */
  reason: string | null
  files_changed: string[]
  created_at: string
}

export interface RewindTarget {
  message_id: number
  text: string
  created_at: string
  /** Messages a conversation rewind to this prompt drops from the agent's context. */
  message_count: number
}

/** What restoring code to just before a prompt would change, from a dry run. */
export interface RewindFilesPreview {
  can_rewind: boolean
  error: string | null
  files: string[]
  insertions: number
  deletions: number
}

export interface RewindResult {
  task: Task
  rewind: TaskRewind
  /** The prompt text, for the composer to offer again when the conversation went back. */
  prompt: string
}
