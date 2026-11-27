let live = false

/** Notes whether an EA call is connecting or connected, so nothing reloads the page under it. */
export const setCallLive = (on: boolean): void => {
  live = on
}

export const callLive = (): boolean => live
