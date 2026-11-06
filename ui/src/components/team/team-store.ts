import type { TeamMember, TeamMessage, TeamWindow } from '@seti/shared'
import { apiGet } from '@/api'
import { armLanding } from '@/components/shortcuts/landing'

const OPEN_KEY = 'seti.team.open'
const SEEN_KEY = 'seti.team.seen'
/** Messages kept in memory; older ones stay in the database. */
const KEEP = 300
/** Messages the stream opens with and each earlier page holds, matching the server's backlog. */
const TEAM_PAGE = 50

export interface TeamState {
  open: boolean
  messages: readonly TeamMessage[]
  members: readonly TeamMember[]
  /** The newest message id the user has seen; null until the first backlog arrives. */
  seen: number | null
  connected: boolean
  /** Whether messages before the oldest loaded one exist, for Load earlier. */
  hasOlder: boolean
  loadingOlder: boolean
  /** Messages around a search hit far back, shown instead of the newest until the user returns. */
  window: TeamWindow | null
  loadingNewer: boolean
  /** Changes each time the list is asked to return to the newest messages. */
  latestRequest: number
}

/** What the message list shows: the window around a hit, or the newest messages. */
export function shownMessages(state: TeamState): { messages: readonly TeamMessage[]; hasOlder: boolean } {
  return state.window === null
    ? { messages: state.messages, hasOlder: state.hasOlder }
    : { messages: state.window.messages, hasOlder: state.window.has_older }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    return
  }
}

function storedSeen(): number | null {
  const value = Number(read(SEEN_KEY))
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/** Messages from others the user has not seen, counted for the toggle's badge. */
export const unreadCount = (state: TeamState) =>
  state.seen === null ? 0 : state.messages.filter((m) => m.id > (state.seen ?? 0) && m.author_kind !== 'user').length

function merged(
  current: readonly TeamMessage[],
  incoming: readonly TeamMessage[],
  keep: number,
): readonly TeamMessage[] {
  const known = new Set(current.map((m) => m.id))
  const fresh = incoming.filter((m) => !known.has(m.id))
  if (fresh.length === 0) {
    return current
  }
  return [...current, ...fresh].sort((a, b) => a.id - b.id).slice(-keep)
}

/** The group chat for the whole app: panel open or closed, messages, handles and what was seen. */
export class TeamChatStore {
  /** Phones pass false: there the panel is a sheet over every page, so it starts closed. */
  constructor({ restoreOpen = true }: { restoreOpen?: boolean } = {}) {
    this.state.open = restoreOpen && read(OPEN_KEY) === '1'
  }

  private state: TeamState = {
    open: false,
    messages: [],
    members: [],
    seen: storedSeen(),
    connected: false,
    hasOlder: false,
    loadingOlder: false,
    window: null,
    loadingNewer: false,
    latestRequest: 0,
  }
  /** Earlier messages the user loaded, kept on top of the live cap. */
  private earlier = 0
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = () => this.state

  setOpen(open: boolean): void {
    if (open && !this.state.open) {
      armLanding('team')
    }
    write(OPEN_KEY, open ? '1' : '0')
    this.update({ open })
    if (open) {
      this.markSeen()
    }
  }

  toggle(): void {
    this.setOpen(!this.state.open)
  }

  private reconnector: (() => void) | null = null

  /** Set by whoever owns the stream, so the panel can ask for a fresh connection. */
  onReconnect(reconnect: (() => void) | null): void {
    this.reconnector = reconnect
  }

  reconnect(): void {
    this.reconnector?.()
  }

  setConnected(connected: boolean): void {
    if (connected !== this.state.connected) {
      this.update({ connected })
    }
  }

  /** The stream's opening messages; a full first page means earlier ones exist. */
  receiveBacklog(messages: readonly TeamMessage[]): void {
    if (this.state.messages.length === 0) {
      this.update({ hasOlder: messages.length >= TEAM_PAGE })
    }
    this.receive(messages)
  }

  /** The newest messages in place of those shown, after a gap too long for the stream to fill. */
  resetMessages(messages: readonly TeamMessage[]): void {
    this.earlier = 0
    this.update({ messages, hasOlder: messages.length >= TEAM_PAGE })
    if (this.state.open) {
      this.markSeen()
    }
  }

  /** Loads the page before the oldest shown message. */
  async loadOlder(): Promise<void> {
    const shown = shownMessages(this.state)
    const oldest = shown.messages[0]?.id
    if (oldest === undefined || this.state.loadingOlder || !shown.hasOlder) {
      return
    }
    this.update({ loadingOlder: true })
    try {
      const page = await apiGet<TeamMessage[]>(`/team/messages?before=${String(oldest)}&limit=${String(TEAM_PAGE)}`)
      const hasOlder = page.length === TEAM_PAGE
      const { window } = this.state
      if (window === null) {
        this.earlier += page.length
        this.update({ messages: merged(this.state.messages, page, KEEP + this.earlier), hasOlder })
      } else {
        this.update({ window: { ...window, messages: [...page, ...window.messages], has_older: hasOlder } })
      }
    } finally {
      this.update({ loadingOlder: false })
    }
  }

  /** Shows the messages around `id`, fetching them unless they are loaded already. */
  async jumpTo(id: number): Promise<void> {
    const { window, messages } = this.state
    if ((messages[0]?.id ?? Number.POSITIVE_INFINITY) <= id) {
      if (window !== null) {
        this.update({ window: null })
      }
      return
    }
    if (window !== null && (window.messages[0]?.id ?? id + 1) <= id && id <= (window.messages.at(-1)?.id ?? 0)) {
      return
    }
    const found = await apiGet<TeamWindow>(`/team/messages?around=${String(id)}&limit=${String(TEAM_PAGE)}`)
    if (found.has_newer) {
      this.update({ window: found })
    } else {
      this.rejoin(found.messages, found.has_older)
    }
  }

  /** Loads the page after a window, joining it to the newest messages once it reaches them. */
  async loadNewer(): Promise<void> {
    const { window } = this.state
    const newest = window?.messages.at(-1)?.id
    if (window === null || newest === undefined || this.state.loadingNewer) {
      return
    }
    this.update({ loadingNewer: true })
    try {
      const page = await apiGet<TeamMessage[]>(`/team/messages?after=${String(newest)}&limit=${String(TEAM_PAGE)}`)
      if (page.length === TEAM_PAGE) {
        this.update({ window: { ...window, messages: [...window.messages, ...page] } })
      } else {
        this.rejoin([...window.messages, ...page], window.has_older)
      }
    } finally {
      this.update({ loadingNewer: false })
    }
  }

  backToLatest(): void {
    this.update({ window: null, latestRequest: this.state.latestRequest + 1 })
  }

  private rejoin(rows: readonly TeamMessage[], hasOlder: boolean): void {
    const messages = merged(this.state.messages, rows, Number.MAX_SAFE_INTEGER)
    this.earlier = Math.max(0, messages.length - KEEP)
    this.update({ messages, hasOlder, window: null })
  }

  /** New messages; a first visit counts what was already there as seen. */
  receive(messages: readonly TeamMessage[]): void {
    const next = merged(this.state.messages, messages, KEEP + this.earlier)
    if (next !== this.state.messages) {
      this.update({ messages: next })
    }
    if (this.state.seen === null || this.state.open) {
      this.markSeen()
    }
  }

  setMembers(members: readonly TeamMember[]): void {
    this.update({ members })
  }

  upsertMember(member: TeamMember): void {
    const others = this.state.members.filter((m) => m.task_id !== member.task_id)
    this.update({ members: [...others, member] })
  }

  markSeen(): void {
    const latest = this.state.messages.at(-1)?.id ?? 0
    if (latest > (this.state.seen ?? 0) || this.state.seen === null) {
      write(SEEN_KEY, String(latest))
      this.update({ seen: latest })
    }
  }

  private update(change: Partial<TeamState>): void {
    this.state = { ...this.state, ...change }
    for (const listener of this.listeners) {
      listener()
    }
  }
}
