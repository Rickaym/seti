let stopping = false

/** Seti began to stop: what waits on the user stays open, and cut turns resume at the next start. */
export function stopForRestart(): void {
  stopping = true
}

export const stoppingForRestart = () => stopping
