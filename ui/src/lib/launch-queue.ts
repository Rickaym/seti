import { launchMove, type LaunchMove } from '@/lib/launch-move'
import { mayLeave } from '@/lib/leave-guard'
import { revealNeedsYou } from '@/lib/needs-you'

/** The Launch Handler API, which the DOM types do not list yet. */
interface LaunchParams {
  readonly targetURL?: string
}

interface LaunchQueue {
  setConsumer: (consumer: (params: LaunchParams) => void) => void
}

function apply(move: LaunchMove): void {
  if (move === null) {
    return
  }
  if (move.kind === 'needs-you') {
    revealNeedsYou()
    return
  }
  void mayLeave().then((ok) => {
    if (!ok) {
      return
    }
    if (move.kind === 'hash') {
      window.location.hash = move.hash
    } else {
      window.location.assign(move.url)
    }
  })
}

/** Routes each launch of the installed app inside the running page, which keeps a live call. */
export function routeLaunches(): void {
  const queue = (window as { launchQueue?: LaunchQueue }).launchQueue
  const loadedWith = window.location.href
  let first = true
  queue?.setConsumer(({ targetURL }) => {
    const opening = first && targetURL === loadedWith
    first = false
    if (targetURL !== undefined && !opening) {
      apply(launchMove(targetURL, new URL(window.location.href)))
    }
  })
}
