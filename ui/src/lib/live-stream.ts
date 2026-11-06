interface LiveStreamState {
  connected: boolean
  lastEventAt: number | null
}

let state: LiveStreamState = { connected: false, lastEventAt: null }
const listeners = new Set<() => void>()

function update(change: Partial<LiveStreamState>): void {
  state = { ...state, ...change }
  for (const listener of listeners) {
    listener()
  }
}

/** Health of the app-wide event stream, which the group chat keeps open on every page. */
export const liveStream = {
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  getSnapshot: () => state,
  setConnected: (connected: boolean) => {
    if (connected !== state.connected) {
      update({ connected })
    }
  },
  received: () => {
    update({ lastEventAt: Date.now() })
  },
}
