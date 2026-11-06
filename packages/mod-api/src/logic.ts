import type { ModCaller } from '@seti/shared'

/** What Seti tells a handler about the event; informational only, since grants never depend on it. */
export interface ModContext {
  eventId: string
  mod: { id: string; version: string }
  caller: ModCaller
  agentId?: string
}

/** A response's headers, by name in any case. */
export interface SetiHeaders {
  get: (name: string) => string | null
  has: (name: string) => boolean
  entries: () => [string, string][]
}

/** A response from `seti.fetch`; Seti read the whole body before the handler sees it. */
export interface SetiFetchResponse {
  status: number
  ok: boolean
  url: string
  headers: SetiHeaders
  text: () => Promise<string>
  json: () => Promise<unknown>
}

export interface SetiFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  /** A connection the user bound to this mod; Seti adds its key on its own server. */
  connection?: string
}

/** A task as `seti.tasks` returns it. */
export interface SetiTask {
  id: string
  title: string
  handle: string | null
  status: string
  pr_urls: string[]
  updated_at: string
}

/**
 * Everything a mod's logic can call, one method per operation. The comment on each names the
 * capability it needs; without it the call throws an Error whose code is `denied`.
 */
export interface Seti {
  settings: { get: () => Promise<Record<string, unknown>> }
  /** storage */
  storage: {
    get: (key: string) => Promise<unknown>
    keys: (prefix?: string) => Promise<string[]>
    set: (key: string, value: unknown) => Promise<void>
    delete: (key: string) => Promise<void>
  }
  log: (...values: unknown[]) => void
  /** A kind the manifest declares in auditKinds. */
  audit: (kind: string, summary: string, detail?: Record<string, unknown>) => Promise<void>
  /** notify, for a kind the manifest declares. */
  notify: (kind: string, message: { title: string; body: string; url?: string }) => Promise<void>
  /** net.fetch, or connection with `init.connection`. */
  fetch: (url: string, init?: SetiFetchInit) => Promise<SetiFetchResponse>
  /** tasks.read for reads; tasks.manage with the action for changes. */
  tasks: {
    list: (filter?: { status?: string; limit?: number }) => Promise<SetiTask[]>
    get: (id: string) => Promise<SetiTask>
    /** The newest entries first fetched, at most 50 a call; direct messages stay hidden. */
    transcript: (id: string, page?: { limit?: number; before?: number }) => Promise<{ messages: unknown[] }>
    prs: (id: string) => Promise<unknown[]>
    rename: (id: string, title: string) => Promise<void>
    pin: (id: string, on: boolean) => Promise<void>
    setColor: (id: string, color: string) => Promise<void>
    linkPr: (id: string, url: string) => Promise<void>
    unlinkPr: (id: string, url: string) => Promise<void>
    /** Asks the user first; resolves to the ask, never to a started agent. */
    start: (task: { title: string; prompt: string; repo?: string }) => Promise<{ asked: string }>
    stop: (id: string) => Promise<{ asked: string }>
  }
  /** chat.post with public, or direct with `to`. */
  chat: { post: (text: string, options?: { to?: string }) => Promise<void> }
  /** files.read */
  files: {
    list: (
      agentId: string,
      dir: string,
    ) => Promise<{ path: string; entries: { name: string; path: string; type: 'file' | 'dir'; size: number }[] }>
    /** Text files only, at most 512 KB, with credentials redacted. */
    read: (agentId: string, path: string) => Promise<{ path: string; size: number; text: string }>
  }
  /** One of the status bar items the manifest declares. */
  statusBar: { set: (itemId: string, item: { text: string; icon?: string }) => Promise<void> }
}

type Handler<In, Out> = (input: In, ctx: ModContext, seti: Seti) => Promise<Out> | Out

/** A verified delivery: its content-type, user-agent and x- headers, and the JSON body as text. */
export interface WebhookDelivery {
  sourceId: string
  headers: Record<string, string>
  body: string
  receivedAt: string
}

/** The channel event a delivery becomes; Seti redacts credentials and clips each field. */
export interface WebhookItem {
  title: string
  body?: string
  url?: string | null
  kind?: string
  severity?: 'info' | 'success' | 'warning' | 'critical'
}

/** The handlers `logic.js` exports by default, one per activation event it declares. */
export interface LogicHandlers {
  /** What a command returns is its result; `{ text }` is shown to whoever ran it. */
  commands?: Record<string, Handler<Record<string, unknown>, unknown>>
  /** One event for the channel, or null to ignore the delivery. */
  webhooks?: Record<string, Handler<WebhookDelivery, WebhookItem | null>>
  schedules?: Record<string, Handler<{ scheduleId: string; since: string | null; now: string }, void>>
  taskEvents?: Handler<{ type: string; taskId: string; at: string }, void>
}

/** Declares a mod's logic; an identity function the bundler keeps for its types. */
export const defineLogic = <T extends LogicHandlers>(handlers: T): T => handlers
