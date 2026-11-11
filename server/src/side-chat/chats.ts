import { randomUUID } from 'node:crypto'
import type { Task } from '@seti/shared'
import { audit } from '../audit.js'
import { onShutdown } from '../background.js'
import { HttpError } from '../http.js'
import { asides } from '../store/asides.js'

/** Side chats answering at once across every agent, each a Claude Code process. */
const ANSWERING_MAX = 4

/** A side chat while it answers; its questions and answers live in `task_aside`. */
export interface SideChat {
  readonly id: string
  readonly taskId: string
  /** Aborts the answer being written. */
  readonly abort: AbortController
}

const answering = new Map<string, SideChat>()

/** Takes the chat up for one answer; `done` frees it for the next question. */
function begin(taskId: string, chatId: string): SideChat {
  if (answering.has(chatId)) {
    throw new HttpError(409, 'The side chat is still answering')
  }
  if (answering.size >= ANSWERING_MAX) {
    throw new HttpError(429, 'Too many side chats are answering; try again in a moment')
  }
  const chat: SideChat = { id: chatId, taskId, abort: new AbortController() }
  answering.set(chatId, chat)
  return chat
}

/** Starts a side chat with the agent and audits its start, never its content. */
export async function openChat(task: Task, reads: boolean): Promise<SideChat> {
  const chat = begin(task.id, randomUUID())
  await audit.record({
    actor: 'user',
    kind: 'task.side_chat',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Started a side chat with agent "${task.title}"`,
    detail: { title: task.title, reads_files: reads },
  })
  return chat
}

/** One of the agent's stored chats for a follow-up question, once it is free to answer. */
export async function followUp(taskId: string, chatId: string): Promise<SideChat> {
  if ((await asides.chat(taskId, chatId, 1)).length === 0) {
    throw new HttpError(404, 'That side chat is gone; start a new one')
  }
  return begin(taskId, chatId)
}

/** Frees the chat once its answer is done or stopped. */
export function done(chat: SideChat): void {
  if (answering.get(chat.id) === chat) {
    answering.delete(chat.id)
  }
}

/** Stops every answer an agent's side chats are writing, as archiving or deleting it does. */
export function closeAgentChats(taskId: string): void {
  for (const chat of [...answering.values()]) {
    if (chat.taskId === taskId) {
      chat.abort.abort()
      answering.delete(chat.id)
    }
  }
}

/** Stops every answer being written, as turning the side chat off or shutting down does. */
export function closeAllChats(): void {
  for (const chat of answering.values()) {
    chat.abort.abort()
  }
  answering.clear()
}

onShutdown(async () => {
  closeAllChats()
  return Promise.resolve()
})
