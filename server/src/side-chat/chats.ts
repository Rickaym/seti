import { randomUUID } from 'node:crypto'
import { SIDE_CHAT_TURNS, type Task } from '@seti/shared'
import { audit } from '../audit.js'
import { onShutdown } from '../background.js'
import { HttpError } from '../http.js'

/** Side chats one agent keeps open; a new one closes the oldest that is not answering. */
const PER_AGENT = 3
/** Side chats answering at once across every agent, each a Claude Code process. */
const ANSWERING_MAX = 4
/** A side chat nobody asked anything for this long is forgotten. */
const IDLE_MS = 30 * 60_000

/** One question and the answer it got, which a follow-up hands the next fork. */
interface Exchange {
  question: string
  answer: string
}

/** A side chat: only its questions and answers, in Seti's memory, never stored anywhere. */
export interface SideChat {
  readonly id: string
  readonly taskId: string
  readonly exchanges: Exchange[]
  /** Aborts the answer being written; null between questions. */
  answering: AbortController | null
  usedAt: number
}

const chats = new Map<string, SideChat>()

function forgetIdle(now: number): void {
  for (const [id, chat] of chats) {
    if (chat.answering === null && now - chat.usedAt > IDLE_MS) {
      chats.delete(id)
    }
  }
}

/** Questions the chat still takes after the one being asked now. */
export const turnsLeft = (chat: SideChat) => Math.max(0, SIDE_CHAT_TURNS - chat.exchanges.length - 1)

function refuseBusyHost(): void {
  if ([...chats.values()].filter((chat) => chat.answering !== null).length >= ANSWERING_MAX) {
    throw new HttpError(429, 'Too many side chats are answering; try again in a moment')
  }
}

/** Makes room for one more of the agent's side chats by closing its oldest idle one. */
function makeRoom(taskId: string): void {
  const own = [...chats.values()].filter((chat) => chat.taskId === taskId)
  if (own.length < PER_AGENT) {
    return
  }
  const oldest = own.filter((chat) => chat.answering === null).toSorted((a, b) => a.usedAt - b.usedAt)[0]
  if (oldest === undefined) {
    throw new HttpError(429, `This agent already has ${String(PER_AGENT)} side chats answering`)
  }
  chats.delete(oldest.id)
}

/** Starts a side chat with the agent and audits its start, never its content. */
export async function openChat(task: Task, reads: boolean): Promise<SideChat> {
  forgetIdle(Date.now())
  refuseBusyHost()
  makeRoom(task.id)
  const chat: SideChat = { id: randomUUID(), taskId: task.id, exchanges: [], answering: null, usedAt: Date.now() }
  chats.set(chat.id, chat)
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

/** The agent's open side chat for a follow-up question, once it is free to answer. */
export function followUp(taskId: string, chatId: string): SideChat {
  forgetIdle(Date.now())
  const chat = chats.get(chatId)
  if (chat?.taskId !== taskId) {
    throw new HttpError(404, 'That side chat is closed; start a new one')
  }
  if (chat.answering !== null) {
    throw new HttpError(409, 'The side chat is still answering')
  }
  if (chat.exchanges.length >= SIDE_CHAT_TURNS) {
    throw new HttpError(409, `This side chat took its ${String(SIDE_CHAT_TURNS)} questions; start a new one`)
  }
  refuseBusyHost()
  return chat
}

/** Ends a side chat and anything it is answering; its questions and answers are gone. */
export function closeChat(taskId: string, chatId: string): void {
  const chat = chats.get(chatId)
  if (chat?.taskId !== taskId) {
    return
  }
  chats.delete(chatId)
  chat.answering?.abort()
}

/** Ends every side chat of an agent, as archiving or deleting it does. */
export function closeAgentChats(taskId: string): void {
  for (const chat of [...chats.values()]) {
    closeChat(taskId, chat.id)
  }
}

/** Ends every side chat of every agent, as turning the side chat off or shutting down does. */
export function closeAllChats(): void {
  for (const chat of chats.values()) {
    chat.answering?.abort()
  }
  chats.clear()
}

onShutdown(async () => {
  closeAllChats()
  return Promise.resolve()
})
