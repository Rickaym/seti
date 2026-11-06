import type { TaskStatus } from '@seti/shared'

/** Marks an agent whose last turn ended after the user last looked at it. */
export function UnseenDot() {
  return (
    <span
      role="img"
      aria-label="unseen"
      title="Unseen: finished since you last looked"
      className="size-1.5 shrink-0 rounded-full bg-primary"
    />
  )
}

/** The header's dot, hidden while a turn runs even before the list catches up. */
export function HeaderUnseenDot({ unseen, status }: { unseen: boolean; status: TaskStatus }) {
  return unseen && status !== 'running' ? <UnseenDot /> : null
}
