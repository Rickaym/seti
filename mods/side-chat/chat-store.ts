import { SIDE_CHAT_TURNS, sideChatEvent, type SideChatEvent, type UiModApi } from '@seti/mod-api'

/** One question of a side chat, with its answer as far as it streamed. */
export interface SideExchange {
  id: number
  question: string
  answer: string
  /** The files the answer read, as "Read src/app.ts". */
  reads: string[]
  state: 'answering' | 'done' | 'failed'
  error: string | null
}

/** One agent's side chat as its dock shows it. */
interface ChatView {
  exchanges: readonly SideExchange[]
  answering: boolean
  turnsLeft: number
}

interface Chat {
  view: ChatView
  /** The server's id for the chat once its first answer started. */
  chatId: string | null
  inFlight: AbortController | null
  nextId: number
}

const ENDED = 'The side chat ended without an answer'

const EMPTY: ChatView = { exchanges: [], answering: false, turnsLeft: SIDE_CHAT_TURNS }

/** What an event does to the exchange it answers. */
function applied(exchange: SideExchange, event: SideChatEvent): SideExchange {
  switch (event.type) {
    case 'start':
      return exchange
    case 'text':
      return { ...exchange, answer: event.text }
    case 'tool':
      return { ...exchange, reads: [...exchange.reads, event.text] }
    case 'done':
      return { ...exchange, answer: event.text, state: 'done' }
    case 'error':
      return { ...exchange, state: 'failed', error: event.error }
  }
}

const viewOf = (exchanges: readonly SideExchange[], turnsLeft: number): ChatView => ({
  exchanges,
  answering: exchanges.some((exchange) => exchange.state === 'answering'),
  turnsLeft,
})

export type SideChats = ReturnType<typeof sideChats>

/**
 * Each agent's side chat: questions stream their answers here and nowhere else. Resetting one, as
 * closing its dock does, ends the chat on the server and discards it.
 */
export function sideChats(api: Pick<UiModApi, 'request' | 'stream' | 'kit'>) {
  const chats = new Map<string, Chat>()
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) {
      listener()
    }
  }
  const chatOf = (agent: string): Chat => {
    const found = chats.get(agent)
    if (found !== undefined) {
      return found
    }
    const chat: Chat = { view: EMPTY, chatId: null, inFlight: null, nextId: 0 }
    chats.set(agent, chat)
    return chat
  }
  const reset = (agent: string) => {
    const chat = chats.get(agent)
    if (chat === undefined) {
      return
    }
    chats.delete(agent)
    chat.inFlight?.abort()
    if (chat.chatId !== null) {
      void api.request('DELETE', `/tasks/${encodeURIComponent(agent)}/chats/${chat.chatId}`).catch(() => undefined)
    }
    notify()
  }

  const ask = (agent: string, question: string) => {
    const chat = chatOf(agent)
    const id = ++chat.nextId
    const change = (next: (view: ChatView) => ChatView) => {
      chat.view = next(chat.view)
      if (chats.get(agent) === chat) {
        notify()
      }
    }
    const exchange = (next: (exchange: SideExchange) => SideExchange) => {
      change((view) =>
        viewOf(
          view.exchanges.map((e) => (e.id === id ? next(e) : e)),
          view.turnsLeft,
        ),
      )
    }
    const fail = (error: string) => {
      exchange((e) => (e.state === 'answering' ? { ...e, state: 'failed', error } : e))
    }
    const asked: SideExchange = { id, question, answer: '', reads: [], state: 'answering', error: null }
    change((view) => viewOf([...view.exchanges, asked], view.turnsLeft))
    const controller = new AbortController()
    chat.inFlight = controller
    const onEvent = (data: unknown) => {
      const parsed = sideChatEvent.safeParse(data)
      if (!parsed.success) {
        return
      }
      const event = parsed.data
      if (event.type === 'start') {
        chat.chatId = event.chat_id
      }
      if (event.type === 'start' || event.type === 'done') {
        change((view) => viewOf(view.exchanges, event.turns_left))
      }
      exchange((e) => applied(e, event))
    }
    const body = { question, ...(chat.chatId === null ? {} : { chat_id: chat.chatId }) }
    void api
      .stream(`/tasks/${encodeURIComponent(agent)}`, body, onEvent, controller.signal)
      .then(() => {
        fail(ENDED)
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) {
          fail(api.kit.errorText(e))
        }
      })
      .finally(() => {
        if (chat.inFlight === controller) {
          chat.inFlight = null
        }
      })
  }

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    view: (agent: string): ChatView => chats.get(agent)?.view ?? EMPTY,
    /** Asks in the agent's chat, in a new one once this one took its questions. */
    ask: (agent: string, question: string) => {
      if (chats.get(agent)?.view.turnsLeft === 0) {
        reset(agent)
      }
      ask(agent, question)
    },
    reset,
    /** Drops every chat here alone, as turning the mod off does; Seti closes them on its side. */
    forgetAll: () => {
      for (const chat of chats.values()) {
        chat.inFlight?.abort()
      }
      chats.clear()
      notify()
    },
  }
}
