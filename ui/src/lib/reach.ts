export interface ReachState {
  /** Polls go unanswered: the link or the server is slow or gone, and views hold their last data. */
  reconnecting: boolean
  /** When the server last answered a poll, as of the moment polls began to go unanswered. */
  lastAnswer: number | null
}

export interface Reach {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => ReachState
  /** The server answered a poll; an error status counts, since it shows the server is there. */
  answered: () => void
  /** A poll sent at `sentAt` timed out or never arrived; ignored when an answer came since. */
  unanswered: (sentAt: number) => void
}

const REACHED: ReachState = { reconnecting: false, lastAnswer: null }

/** Whether the server answers polls, as one state for every poller; any answer clears it. */
export function createReach(now: () => number = Date.now): Reach {
  let state = REACHED
  let lastAnswer: number | null = null
  const listeners = new Set<() => void>()

  const set = (next: ReachState) => {
    state = next
    for (const listener of listeners) {
      listener()
    }
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => state,
    answered: () => {
      lastAnswer = now()
      if (state.reconnecting) {
        set(REACHED)
      }
    },
    unanswered: (sentAt) => {
      if (!state.reconnecting && (lastAnswer === null || lastAnswer <= sentAt)) {
        set({ reconnecting: true, lastAnswer })
      }
    },
  }
}

/** Whether Seti's server answers this browser's polls. */
export const appReach = createReach()
