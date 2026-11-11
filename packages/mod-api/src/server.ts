import type {
  Aside,
  AuditDetail,
  ChannelState,
  Changelog,
  ChangelogStatus,
  Disposer,
  EaNoticeSeverity,
  ModManifest,
  Preview,
  PullRequest,
  SetiUpdate,
  SideChatEvent,
  WorkspaceGrid,
} from '@seti/shared'

/** Who made a request or ran a command: the user in Seti, the EA, or an agent. */
export interface ModCaller {
  source: 'user' | 'ea' | 'agent'
  /** The agent's id when an agent asked through its seti tools. */
  agent: string | null
}

/** A request to one of the mod's routes, after Seti checked who sent it. */
export interface ModRequest {
  params: Readonly<Record<string, string>>
  query: Readonly<Record<string, string>>
  /** The JSON body of a write, or null for a read. */
  body: unknown
  /** Who sent it; the mod's own calls still run as the mod. */
  caller: ModCaller
}

/** What a route answers: JSON with 200, or a refusal whose body is the reason the user reads. */
export interface ModResponse {
  status?: 200 | 400 | 403 | 404 | 409 | 422
  body: unknown
}

export type ModRouteHandler = (request: ModRequest) => Promise<ModResponse>

/** Server-sent events a streaming route writes, one at a time, to whoever called it. */
export interface ModEventStream {
  /** Writes one event, its data as JSON. */
  send: (event: string, data: unknown) => Promise<void>
  /** Aborts when the caller goes away, so the handler can stop its work. */
  readonly signal: AbortSignal
}

/**
 * Answers a route the manifest marks `stream`. A throw before the first event answers as a
 * refusal, as an ordinary route's does; once an event went out, the stream ends with the handler.
 */
export type ModStreamHandler = (request: ModRequest, stream: ModEventStream) => Promise<void>

/** One run of a mod command, with arguments Seti already checked against the manifest. */
export interface ModCommandCall {
  /** By the manifest's names; task holds the id of the agent Seti resolved it to. */
  args: Readonly<Record<string, unknown>>
  /** Who asked: the user in Seti, the EA, or an agent through its seti tool. */
  caller: ModCaller
}

/** What a command answers: a string, or JSON whose text field Seti shows when it has one. */
export type ModCommandHandler = (call: ModCommandCall) => Promise<unknown>

export interface ModFetchInit {
  method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  headers?: Record<string, string>
  body?: string
}

export interface ModFetchResponse {
  status: number
  url: string
  headers: [string, string][]
  body: string
}

export interface ModNotification {
  title: string
  body: string
  /** Where tapping it opens Seti, such as `/#settings/mods`; Seti's start page without one. */
  url?: string
}

/** One event a webhook delivery reports, as the mod reads it from the payload. */
export interface WebhookEvent {
  /** What reported it, such as a repository or project. */
  source: string
  severity: EaNoticeSeverity
  title: string
  detail: string
  url: string | null
  /** What happened, such as pull_request.opened; subscriptions filter on it. */
  kind?: string
  occurred_at: string
  /** What `state` belongs to, such as a monitor; Seti routes only changes of state. */
  subject?: string
  state?: ChannelState
}

/** A payload maps to one event, or to nothing worth reporting, with the reason. */
export type WebhookParsed = { kind: 'event'; fields: WebhookEvent } | { kind: 'ignore'; reason: string }

/** A delivery as the sender would send it, before Seti signs it with the channel's secret. */
export interface WebhookSample {
  headers: Record<string, string>
  body: string
}

/** The code half of a webhook source the manifest declares; Seti verifies before parse runs. */
export interface WebhookSourceHandler {
  /** Reads a payload whose signature Seti already checked. */
  parse: (payload: unknown, headers: Headers) => WebhookParsed
  /** A delivery for the Test button; Seti adds the signature and delivery id headers. */
  sample: () => WebhookSample
}

/** An issue comment on a PR, as Seti fetched it with the PR. */
export interface PrComment {
  author: string | null
  body: string
  updatedAt: string
}

/** The PR a decorator reads, beside its newest 30 comments. */
export interface PrSubject {
  slug: string
  number: number
  headOid: string
}

/** What a decorator fills in on a PR: its preview, and the Seti subdomain that serves it. */
export interface PrDecoration {
  preview?: Preview
  preview_host?: string | null
}

export type PrDecorator = (pr: PrSubject, comments: readonly PrComment[]) => PrDecoration

/** An open PR of a registered repo, with the fields decorators filled in. */
export type OpenPrSummary = Pick<PullRequest, 'repo_slug' | 'number' | 'url' | 'preview' | 'preview_host'>

/** Seti's open PRs, for a mod whose manifest declares a PR decorator; bundled mods only. */
export interface ModPrsApi {
  /** Fills in fields of each PR as Seti fetches it from GitHub; Seti checks what it gives. */
  decorate: (id: string, decorator: PrDecorator) => Disposer
  /** The open PRs of registered repos, as last fetched and decorated. */
  open: () => Promise<OpenPrSummary[]>
}

/** The HTTPS origin a Seti subdomain is served from, such as a PR's preview; null when unknown. */
export type HostResolver = (hostname: string) => Promise<string | null>

/** The panel layout each workspace keeps, shared by every device. */
export interface ModWorkspaceGrids {
  list: () => Promise<WorkspaceGrid[]>
  /**
   * Stores `layout` as `{ layout }` for the workspace after Seti checks it; refuses an unknown
   * workspace with 404, and a terminal the EA or an agent adds with 403.
   */
  put: (workspaceId: string, body: unknown, caller: ModCaller) => Promise<WorkspaceGrid>
}

export interface ModWorkspaces {
  readonly grids: ModWorkspaceGrids
}

/** Seti's own version, its changelog and whether a newer one is out. */
export interface SetiVersionApi {
  /** The newest `limit` commits of the running version, each marked current or unseen. */
  changelog: (limit: number) => Promise<Changelog>
  /** The version, how many notable commits are unseen, and the last update check. */
  status: () => Promise<ChangelogStatus>
  /** An update check at most two minutes old, waiting for a new one when the last is older. */
  update: () => Promise<SetiUpdate>
  /** Notes that the user read the changelog at `commit`, a full commit hash. */
  markSeen: (commit: string) => Promise<void>
  /** Notes the running commit as a deploy and starts an update check in the background. */
  start: () => Promise<void>
}

/** A side question's whole answer, with the agent it asked and what it cost when known. */
export interface ModAsideAnswer {
  id: string
  title: string
  answer: string
  cost_usd: number | null
}

/**
 * Side questions to an agent, answered by Seti from a fork of the agent's session that never
 * interrupts it or reaches its conversation. Seti stores each answered question as an aside of
 * the agent, redacted, until the agent is deleted. Each call runs as whoever asked the mod: the
 * caller of its route or command. Needs tasks.ask, which only bundled mods get; Seti stops every
 * answer being written when the mod is turned off.
 */
export interface ModAsideApi {
  /**
   * Asks in a new side chat, or follows up in `chat_id`, streaming the answer through `emit`.
   * `input` is the request body, `{ question, chat_id? }`, which Seti checks.
   */
  ask: (
    task: string,
    input: unknown,
    emit: (event: SideChatEvent) => Promise<void>,
    signal: AbortSignal,
  ) => Promise<void>
  /** Asks one question in a chat of its own and answers it whole. */
  answer: (task: string, question: string) => Promise<ModAsideAnswer>
  /** The agent's newest asides, oldest first, whoever asked them. */
  list: (task: string) => Promise<Aside[]>
  /** Deletes one aside of the agent; audited, without its question or answer. */
  remove: (task: string, aside: string) => Promise<void>
  /** Deletes every aside of the agent and says how many went; audited. */
  clear: (task: string) => Promise<number>
}

/** Blocks a mod draws in agents' transcripts, for a mod whose manifest declares transcriptBlocks. */
export interface ModTranscriptApi {
  /**
   * Tells the mod's UI half that its blocks in the agent's transcript changed, over the stream
   * the transcript already reads; the UI half's source then refreshes from the mod's routes.
   */
  refresh: (task: string) => Promise<void>
}

/**
 * What a bundled mod's server half reaches of Seti, and nothing more. Every call runs as the mod,
 * is checked against the capabilities it was granted and is audited as `mod:<id>`.
 */
export interface ServerModApi {
  readonly id: string
  readonly manifest: ModManifest
  /** Its settings as the user saved them, with the manifest's defaults filled in. */
  readonly settings: { get: () => Promise<Record<string, unknown>> }
  /** A private key-value store; needs the storage capability. */
  readonly storage: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
    delete: (key: string) => Promise<void>
    keys: () => Promise<string[]>
  }
  /** Values that expire, shared by Seti's processes; a miss reads undefined. Needs storage. */
  readonly cache: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown, ttlSeconds: number) => Promise<void>
  }
  /** `SETI_<ID>_<NAME>` from Seti's environment; env('URL') in the weather mod is SETI_WEATHER_URL. */
  env: (name: string) => string | undefined
  /** Seti's version, changelog and updates; needs the seti.version capability. */
  readonly version: SetiVersionApi
  /** Seti's workspaces; their layouts need the workspaces.layout capability. */
  readonly workspaces: ModWorkspaces
  /** Raises one of its own notification kinds; returns how many devices got it. */
  notify: (kind: string, note: ModNotification) => Promise<number>
  /** Records one of its own audit kinds, as `mod.<id>.<kind>`. */
  audit: (kind: string, summary: string, detail?: AuditDetail) => Promise<void>
  /** HTTPS to a host its net.fetch capability names, never to this machine or its networks. */
  fetch: (url: string, init?: ModFetchInit) => Promise<ModFetchResponse>
  /** Answers one route its manifest declares, under /api/mods/<id>/. */
  route: (
    method: ModManifest['contributes']['routes'][number]['method'],
    path: string,
    handler: ModRouteHandler,
  ) => Disposer
  /** Answers one route its manifest declares with `stream`, as server-sent events. */
  streamRoute: (
    method: ModManifest['contributes']['routes'][number]['method'],
    path: string,
    handler: ModStreamHandler,
  ) => Disposer
  /** Side questions to agents; needs the tasks.ask capability. */
  readonly aside: ModAsideApi
  /** Its blocks in agents' transcripts; needs a transcriptBlocks entry. */
  readonly transcript: ModTranscriptApi
  /** Runs a command its manifest declares, from the palette, the EA or an agent's seti tool. */
  registerCommand: (id: string, handler: ModCommandHandler) => Disposer
  /** Seti's open PRs and the fields a PR decorator the manifest declares fills in. */
  readonly prs: ModPrsApi
  /**
   * Serves subdomains of Seti's host, such as `app-pr-7.seti.localhost`, from the HTTPS origin the
   * resolver gives for a host proxy the manifest declares; Seti itself proxies every request.
   */
  registerHostProxy: (id: string, resolve: HostResolver) => Disposer
  /** Reads the payloads of a webhook source its manifest declares. */
  registerWebhookSource: (id: string, handler: WebhookSourceHandler) => Disposer
  /** Gives the script of a poller template its manifest declares. */
  registerPollerTemplate: (id: string, template: { script: string }) => Disposer
  /** Runs when the mod is turned off, for timers and the like. */
  onDispose: (dispose: Disposer) => void
}
