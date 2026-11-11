import { sideChatEvent, type Aside, type AsideList, type ModTranscriptBlock, type UiModApi } from '@seti/mod-api'

/** The question being answered now, or the one whose answer failed, with its answer so far. */
export interface PendingAside {
  question: string
  answer: string
  /** The files the answer read, as "Read src/app.ts". */
  reads: string[]
  state: 'answering' | 'failed'
  error: string | null
  asked_at: string
}

/** One agent's asides as the dock and the transcript show them. */
export interface AgentAsides {
  loaded: boolean
  /** Stored asides, oldest first, whoever asked them. */
  asides: readonly Aside[]
  pending: PendingAside | null
  answering: boolean
  /** The next question starts a new chat instead of following up the newest one. */
  startNew: boolean
  /** Asides drawn open in the transcript. */
  open: ReadonlySet<string>
  /** The files each answer this page streamed read; Seti keeps only the answer. */
  reads: ReadonlyMap<string, readonly string[]>
  /** Where the transcript draws them, oldest first. */
  blocks: readonly ModTranscriptBlock[]
}

type AgentState = Omit<AgentAsides, 'answering' | 'blocks'>

/** The block id of the question being answered, until its aside is stored. */
export const PENDING = 'pending'

const ENDED = 'The side chat ended without an answer'

const EMPTY: AgentAsides = {
  loaded: false,
  asides: [],
  pending: null,
  answering: false,
  startNew: false,
  open: new Set(),
  reads: new Map(),
  blocks: [],
}

/** The state with its derived fields worked out again. */
function settled(state: AgentState): AgentAsides {
  const stored = state.asides.map((aside) => ({ id: aside.id, at: aside.asked_at }))
  const pending = state.pending?.state === 'answering' ? state.pending : null
  const live = pending === null ? [] : [{ id: PENDING, at: pending.asked_at }]
  return { ...state, answering: pending !== null, blocks: [...stored, ...live] }
}

/** The chat a question follows up: the newest aside's, unless the user started a new one. */
const chatFor = (state: AgentAsides): string | null => (state.startNew ? null : (state.asides.at(-1)?.chat_id ?? null))

const path = (agent: string, rest = '') => `/tasks/${encodeURIComponent(agent)}${rest}`

/** What a streamed event other than the end does to the question being answered. */
function streamed(pending: PendingAside, event: { type: 'text' | 'tool'; text: string }): PendingAside {
  return event.type === 'text'
    ? { ...pending, answer: event.text }
    : { ...pending, reads: [...pending.reads, event.text] }
}

export type SideChats = ReturnType<typeof sideChats>

/**
 * Each agent's asides: those Seti stored, loaded from the mod's route, and the question being
 * answered, streamed here. Seti keeps the asides; this only follows them while something shows.
 */
export function sideChats(api: Pick<UiModApi, 'request' | 'stream' | 'kit'>) {
  const states = new Map<string, AgentAsides>()
  const watchers = new Map<string, number>()
  const inFlight = new Map<string, AbortController>()
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) {
      listener()
    }
  }
  const view = (agent: string): AgentAsides => states.get(agent) ?? EMPTY
  const change = (agent: string, next: (state: AgentAsides) => AgentState) => {
    states.set(agent, settled(next(view(agent))))
    notify()
  }

  const reload = (agent: string) => {
    api
      .request<AsideList>('GET', path(agent, '/asides'))
      .then(({ asides }) => {
        change(agent, (state) => ({ ...state, loaded: true, asides }))
      })
      .catch(() => undefined)
  }

  const finish = (agent: string, stored: Aside) => {
    change(agent, (state) => ({
      ...state,
      asides: [...state.asides.filter((aside) => aside.id !== stored.id), stored],
      pending: null,
      startNew: false,
      open: new Set([...state.open, stored.id]),
      reads: new Map(state.reads).set(stored.id, state.pending?.reads ?? []),
    }))
  }
  const fail = (agent: string, error: string) => {
    change(agent, (state) =>
      state.pending?.state === 'answering'
        ? { ...state, pending: { ...state.pending, state: 'failed', error } }
        : state,
    )
  }
  const onEvent = (agent: string, data: unknown) => {
    const parsed = sideChatEvent.safeParse(data)
    if (!parsed.success) {
      return
    }
    const event = parsed.data
    if (event.type === 'done') {
      finish(agent, event.aside)
    } else if (event.type === 'error') {
      fail(agent, event.error)
    } else if (event.type !== 'start') {
      change(agent, (state) => (state.pending === null ? state : { ...state, pending: streamed(state.pending, event) }))
    }
  }

  const ask = (agent: string, question: string) => {
    const chatId = chatFor(view(agent))
    const pending: PendingAside = {
      question,
      answer: '',
      reads: [],
      state: 'answering',
      error: null,
      asked_at: new Date().toISOString(),
    }
    change(agent, (state) => ({ ...state, pending }))
    const controller = new AbortController()
    inFlight.set(agent, controller)
    const body = { question, ...(chatId === null ? {} : { chat_id: chatId }) }
    const events = (data: unknown) => {
      onEvent(agent, data)
    }
    api
      .stream(path(agent), body, events, controller.signal)
      .then(() => {
        fail(agent, ENDED)
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) {
          fail(agent, api.kit.errorText(e))
        }
      })
      .finally(() => {
        if (inFlight.get(agent) === controller) {
          inFlight.delete(agent)
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
    view,
    ask,
    /** Loads the agent's asides while something shows them; returns the stop. */
    watch: (agent: string) => {
      watchers.set(agent, (watchers.get(agent) ?? 0) + 1)
      if (!view(agent).loaded) {
        reload(agent)
      }
      return () => {
        watchers.set(agent, Math.max(0, (watchers.get(agent) ?? 0) - 1))
      }
    },
    /** Fetches the agent's asides again when something shows them or showed them before. */
    refresh: (agent: string) => {
      if ((watchers.get(agent) ?? 0) > 0 || view(agent).loaded) {
        reload(agent)
      }
    },
    /** Whether the next question starts a new chat or follows up the newest one. */
    setStartNew: (agent: string, on: boolean) => {
      change(agent, (state) => ({ ...state, startNew: on }))
    },
    toggle: (agent: string, id: string) => {
      change(agent, (state) => {
        const open = new Set(state.open)
        if (!open.delete(id)) {
          open.add(id)
        }
        return { ...state, open }
      })
    },
    /** Deletes one stored aside of the agent. */
    remove: async (agent: string, id: string) => {
      await api.request('DELETE', path(agent, `/asides/${encodeURIComponent(id)}`))
      change(agent, (state) => ({ ...state, asides: state.asides.filter((aside) => aside.id !== id) }))
    },
    /** Deletes every stored aside of the agent. */
    clear: async (agent: string) => {
      await api.request('DELETE', path(agent, '/asides'))
      change(agent, (state) => ({ ...state, asides: [], startNew: false }))
    },
    /** Drops what this page holds, as turning the mod off does; Seti stops its answers. */
    forgetAll: () => {
      for (const controller of inFlight.values()) {
        controller.abort()
      }
      inFlight.clear()
      states.clear()
      notify()
    },
  }
}
