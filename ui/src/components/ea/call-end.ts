import { EA_CALL_END_TEXT, type EaCallEndInput, type EaCallEndReason } from '@seti/shared'

const OPEN_KEY = 'seti-ea-call-open'

/** The live call, kept in the tab's storage so a page that dies with it is reported next time. */
interface OpenCall {
  at: number
  auto: boolean
  hiddenAt: number | null
}

export interface TabStorage {
  read: () => string | null
  write: (value: string) => void
  remove: () => void
}

interface CallEndDeps {
  send: (report: EaCallEndInput) => void
  storage: TabStorage
  now: () => number
  hidden: () => boolean
}

export const pageHidden = () => document.visibilityState === 'hidden'

const seconds = (ms: number) => Math.max(0, Math.round(ms / 1000))

function parseOpen(raw: string | null): OpenCall | null {
  try {
    const value: unknown = raw === null ? null : JSON.parse(raw)
    if (typeof value !== 'object' || value === null) {
      return null
    }
    const { at, auto, hiddenAt } = value as Record<string, unknown>
    if (typeof at !== 'number' || typeof auto !== 'boolean') {
      return null
    }
    return { at, auto, hiddenAt: typeof hiddenAt === 'number' ? hiddenAt : null }
  } catch {
    return null
  }
}

/** Reports how each connected call ended, including one the page did not live to see end. */
export class CallEndRecorder {
  private readonly deps: CallEndDeps
  private open: OpenCall | null = null

  constructor(deps: CallEndDeps) {
    this.deps = deps
  }

  private save(): void {
    if (this.open === null) {
      this.deps.storage.remove()
    } else {
      this.deps.storage.write(JSON.stringify(this.open))
    }
  }

  /** Sends the call a previous page in this tab left open: it closed with the call live. */
  readonly recover = (): void => {
    const left = parseOpen(this.deps.storage.read())
    this.deps.storage.remove()
    if (left !== null) {
      const hidden = left.hiddenAt !== null
      this.deps.send({ reason: 'page-closed', auto: left.auto, hidden, duration_s: null, hidden_s: null })
    }
  }

  readonly connected = (auto: boolean): void => {
    const now = this.deps.now()
    this.open = { at: now, auto, hiddenAt: this.deps.hidden() ? now : null }
    this.save()
  }

  /** Notes when the page went to the background, or came back. */
  readonly visibility = (): void => {
    if (this.open === null) {
      return
    }
    const hiddenAt = this.deps.hidden() ? (this.open.hiddenAt ?? this.deps.now()) : null
    this.open = { ...this.open, hiddenAt }
    this.save()
  }

  readonly ended = (reason: EaCallEndReason): void => {
    const open = this.open
    if (open === null) {
      return
    }
    this.open = null
    this.save()
    const now = this.deps.now()
    this.deps.send({
      reason,
      auto: open.auto,
      hidden: open.hiddenAt !== null,
      duration_s: seconds(now - open.at),
      hidden_s: open.hiddenAt === null ? null : seconds(now - open.hiddenAt),
    })
  }
}

export const sessionTabStorage: TabStorage = {
  read: () => {
    try {
      return sessionStorage.getItem(OPEN_KEY)
    } catch {
      return null
    }
  },
  write: (value) => {
    try {
      sessionStorage.setItem(OPEN_KEY, value)
    } catch {
      // Storage can be blocked; a page that dies mid-call then goes unreported.
    }
  },
  remove: () => {
    try {
      sessionStorage.removeItem(OPEN_KEY)
    } catch {
      // Nothing was stored.
    }
  },
}

/** The last end as the settings show it, such as "The network path failed, in the background". */
export function lastEndText(end: { reason: EaCallEndReason; hidden: boolean } | null): string {
  if (end === null) {
    return '-'
  }
  return `${EA_CALL_END_TEXT[end.reason]}${end.hidden ? ', in the background' : ''}`
}
