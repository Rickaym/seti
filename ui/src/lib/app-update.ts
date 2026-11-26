import { systemResource } from '@/hooks/useSystem'
import { isBehind, pageBuild, retryDelay, updateMoment, workerScript } from '@/lib/app-build'
import { readActivity, watchTyping } from '@/lib/page-activity'
import { claimReload } from '@/lib/stale-build'

/** How often a page that waits for a safe moment looks again. */
const SETTLE_CHECK_MS = 2_000
const INSTALL_WAIT_MS = 30_000
/** A reload goes ahead this long after asking the new worker to take over, taken or not. */
const TAKEOVER_WAIT_MS = 4_000
/** Failed worker installs before the page reloads without it; the page itself always loads fresh. */
const WORKER_TRIES = 2

interface Pending {
  /** The build the server hands out; '' when only a missing file said this page is old. */
  target: string
  /** Whether Seti may still reload by itself; off once a reload for this build did not take. */
  auto: boolean
  tries: number
  retryAt: number
}

let registration: ServiceWorkerRegistration | null = null
let pending: Pending | null = null
let offered = false
let applying = false
let reloadOnTakeover = false
/** Whether a signed-in page polls the server's build; before sign-in the API refuses. */
let watching = false
let settle: ReturnType<typeof setInterval> | undefined
const listeners = new Set<() => void>()

/** Whether the Update control shows: a new build waits for a moment the user chooses. */
export const updateOffer = {
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  getSnapshot: () => offered,
}

function setOffered(next: boolean): void {
  if (offered !== next) {
    offered = next
    for (const listener of listeners) {
      listener()
    }
  }
  if (next && settle === undefined) {
    settle = setInterval(consider, SETTLE_CHECK_MS)
  } else if (!next) {
    clearInterval(settle)
    settle = undefined
  }
}

const reload = () => {
  window.location.reload()
}

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

const STILL_INSTALLING = new Set<ServiceWorkerState>(['parsed', 'installing'])

/** Whether the worker finished installing within the wait. */
async function installs(worker: ServiceWorker): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false)
    }, INSTALL_WAIT_MS)
    const check = () => {
      if (!STILL_INSTALLING.has(worker.state)) {
        clearTimeout(timer)
        resolve(worker.state !== 'redundant')
      }
    }
    worker.addEventListener('statechange', check)
    check()
  })
}

const ASK_WAIT_MS = 2_000

/** The build a worker was made with, as it answers; null when it does not answer in time. */
async function workerBuild(worker: ServiceWorker): Promise<string | null> {
  const channel = new MessageChannel()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(null)
    }, ASK_WAIT_MS)
    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timer)
      resolve(typeof event.data === 'string' ? event.data : null)
    }
    worker.postMessage('build', [channel.port2])
  })
}

/** The installed worker of the target build, null when there is none to fetch, or 'failed'. */
async function fetchWorker(target: string): Promise<ServiceWorker | null | 'failed'> {
  if (registration === null) {
    return null
  }
  try {
    await (target === ''
      ? registration.update()
      : navigator.serviceWorker.register(workerScript(target), { updateViaCache: 'none' }))
  } catch {
    return 'failed'
  }
  const worker = registration.installing ?? registration.waiting
  if (worker === null) {
    return null
  }
  if (!(await installs(worker))) {
    return 'failed'
  }
  return target === '' || (await workerBuild(worker)) === target ? worker : 'failed'
}

function reloadInto(worker: ServiceWorker | null): void {
  if (worker === null) {
    reload()
    return
  }
  reloadOnTakeover = true
  worker.postMessage('skip-waiting')
  setTimeout(reload, TAKEOVER_WAIT_MS)
}

/** reload: go ahead, recorded so it never loops. wait: not now. stop: one did not take. */
function selfReload(target: string): 'reload' | 'wait' | 'stop' {
  if (updateMoment(readActivity()) === 'wait') {
    return 'wait'
  }
  return claimReload(sessionStore(), `update:${target}`, Date.now()) ? 'reload' : 'stop'
}

async function apply(byUser: boolean): Promise<void> {
  const next = pending
  if (next === null || applying) {
    return
  }
  applying = true
  try {
    const worker = await fetchWorker(next.target)
    if (worker === 'failed' && !byUser && next.tries < WORKER_TRIES) {
      next.tries += 1
      next.retryAt = Date.now() + retryDelay(next.tries)
      setOffered(true)
      return
    }
    const moment = byUser ? 'reload' : selfReload(next.target)
    if (moment !== 'reload') {
      next.auto = moment === 'wait'
      setOffered(true)
      return
    }
    reloadInto(worker === 'failed' ? null : worker)
  } finally {
    applying = false
  }
}

/** Reloads into the new build when the page is at a safe moment, or offers Update. */
function consider(): void {
  if (pending === null || applying || !pending.auto || Date.now() < pending.retryAt) {
    return
  }
  if (updateMoment(readActivity()) === 'wait') {
    setOffered(true)
    return
  }
  void apply(false)
}

/** Lets a waiting worker take over a page that already runs the build the worker was made with. */
async function letWaitingIn(page: string): Promise<void> {
  const waiting = registration?.waiting ?? null
  if (waiting !== null && (await workerBuild(waiting)) === page) {
    waiting.postMessage('skip-waiting')
  }
}

function noteServerBuild(server: string | null | undefined): void {
  const page = pageBuild(document)
  if (isBehind(page, server)) {
    const target = server ?? ''
    if (pending?.target !== target) {
      pending = { target, auto: true, tries: 0, retryAt: 0 }
    }
    consider()
  } else if (page !== '' && server === page) {
    if (pending?.target !== '') {
      pending = null
      setOffered(false)
    }
    void letWaitingIn(page)
  }
}

/** A file of this page's build is gone from the server, so a newer build is in place. */
export function markBehind(): void {
  pending ??= { target: '', auto: true, tries: 0, retryAt: 0 }
  consider()
}

/** The Update control: reload into the new build now. */
export function updateNow(): void {
  void apply(true)
}

/** Hands over the service worker registration, so updates go through the new worker. */
export function adoptWorker(next: ServiceWorkerRegistration): void {
  registration = next
  const recheck = () => {
    noteServerBuild(systemResource.getSnapshot().data?.build)
  }
  next.addEventListener('updatefound', () => {
    const worker = next.installing
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed') {
        recheck()
      }
    })
  })
  recheck()
}

const checkServer = () => {
  registration?.update().catch(() => undefined)
  if (watching) {
    systemResource.refresh()
  }
}

/** Compares this page's build with the server's on every poll, once the user is signed in. */
export function watchServerBuild(): () => void {
  const stop = systemResource.subscribe(() => {
    noteServerBuild(systemResource.getSnapshot().data?.build)
  })
  watching = true
  return () => {
    watching = false
    stop()
  }
}

/** Watches for a new worker and for the page going to the background and back. */
export function startUpdates(): void {
  watchTyping()
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadOnTakeover) {
        reload()
      }
    })
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      consider()
    } else {
      checkServer()
    }
  })
  window.addEventListener('online', checkServer)
}
