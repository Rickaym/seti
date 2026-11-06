import { z } from 'zod'
import { clientSendId } from './client-send.js'

/** Where the EA's keys live, one file per key, passed to it as systemd credentials. */
export const EA_CREDENTIALS_DIR = '~/.seti/credentials'

/** The credential file of each key the EA health can report missing. */
export const EA_KEY_FILES: Readonly<Record<string, string>> = {
  DEEPGRAM_API_KEY: 'deepgram-api-key',
  OPENAI_API_KEY: 'openai-api-key',
  ELEVENLABS_API_KEY: 'elevenlabs-api-key',
}

export const eaKeyFile = (name: string) => `${EA_CREDENTIALS_DIR}/${EA_KEY_FILES[name] ?? name.toLowerCase()}`
export const EA_SERVICE_UNIT = 'seti-ea.service'

const SDP_MAX = 256 * 1024
const CLOCK_FIELD_MAX = 64

/** The browser's clock, sent with the offer so the EA knows the user's local time. */
const eaRequestData = z.looseObject({
  /** IANA timezone, such as Asia/Singapore. */
  timezone: z.string().max(CLOCK_FIELD_MAX).optional(),
  /** Local time as ISO 8601 with its UTC offset. */
  localTime: z.string().max(CLOCK_FIELD_MAX).optional(),
  /** Joined on open: the EA starts asleep without a greeting and never replaces a live call. */
  auto: z.boolean().optional(),
})
export type EaRequestData = z.input<typeof eaRequestData>

/** A SmallWebRTC offer; unknown fields pass through to the bot. */
export const eaOfferInput = z.looseObject({
  sdp: z.string().min(1).max(SDP_MAX),
  type: z.literal('offer'),
  pc_id: z.string().max(200).nullish(),
  restart_pc: z.boolean().nullish(),
  requestData: eaRequestData.nullish(),
})

/** Trickled ICE candidates for a peer connection the bot already answered. */
export const eaIcePatchInput = z.object({
  pc_id: z.string().min(1).max(200),
  candidates: z
    .array(
      z.object({
        candidate: z.string().max(2000),
        sdp_mid: z.string().max(200).nullish(),
        sdp_mline_index: z.number().int().min(0).nullish(),
      }),
    )
    .max(200),
})

export interface EaHealth {
  ok: boolean
  /** Whether calls can start; the chat needs only the OpenAI key. */
  configured: boolean
  /** Names missing from the EA env file. */
  missing: string[]
  model: string | null
  /** The model behind the typed chat; absent from bots older than the chat. */
  text_model?: string | null
  /** Names the typed chat still needs from the EA env file. */
  chat_missing?: string[]
  /** Whether the bot has TURN keys, so its ICE servers include a relay. */
  turn: boolean
}

/** What /api/ea/health answers in place of the bot's health when nothing listens there. */
export interface EaNotRunning {
  running: false
  reason: string
}

export interface EaIceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

export interface EaIce {
  iceServers: EaIceServer[]
  /** Seconds the credentials stay valid; absent for static ones. */
  ttlSeconds?: number
}

/** The RTVI server message the bot sends after each tool call. */
export const eaActionMessage = z.object({
  type: z.literal('ea-action'),
  tool: z.string(),
  summary: z.string(),
  ok: z.boolean(),
})
export type EaAction = z.output<typeof eaActionMessage>

const CONTENT_MAX = 64 * 1024
const TOOL_ID_MAX = 200

const eaToolCall = z.object({
  id: z.string().min(1).max(TOOL_ID_MAX),
  type: z.literal('function'),
  function: z.object({ name: z.string().min(1).max(200), arguments: z.string().max(CONTENT_MAX) }),
})

/** One message of the EA's LLM conversation, in the OpenAI chat shape the bot keeps. */
const eaLlmMessage = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: z.string().max(CONTENT_MAX) }),
  z.object({
    role: z.literal('assistant'),
    content: z.string().max(CONTENT_MAX).nullish(),
    tool_calls: z.array(eaToolCall).min(1).max(32).optional(),
  }),
  z.object({
    role: z.literal('tool'),
    tool_call_id: z.string().min(1).max(TOOL_ID_MAX),
    content: z.string().max(CONTENT_MAX),
  }),
  z.object({ role: z.literal('developer'), content: z.string().max(CONTENT_MAX) }),
])
export type EaLlmMessage = z.output<typeof eaLlmMessage>

/** message: spoken; chat: typed; call: opens a call; summary: compaction; inbox: a delivered item. */
export type EaHistoryKind = 'message' | 'chat' | 'call' | 'summary' | 'inbox'

export const EA_INBOX_KINDS = ['followup', 'reminder', 'watch_event', 'channel_event', 'team_mention'] as const
export type EaInboxKind = (typeof EA_INBOX_KINDS)[number]

export const EA_NOTICE_SEVERITIES = ['info', 'success', 'warning', 'critical'] as const
export type EaNoticeSeverity = (typeof EA_NOTICE_SEVERITIES)[number]

/** What an inbox item shows in the EA chat. */
export interface EaNotice {
  kind: EaInboxKind
  /** What happened, such as turn_finished, ci_failed or down; due for follow-ups and reminders. */
  event: string
  title: string
  body: string
  url: string | null
  severity: EaNoticeSeverity
  /** Where it came from: a task title, a channel, or the EA itself. */
  source: string
}

export interface EaHistoryEntry {
  id: number
  kind: EaHistoryKind
  message: EaLlmMessage
  /** For a summary, the last entry it stands in for. */
  through_id: number | null
  created_at: string
  /** For an inbox entry in a history page, the item it delivered. */
  notice?: EaNotice | null
}

export interface EaHistoryPage {
  entries: EaHistoryEntry[]
  /** Older entries exist beyond this page. */
  has_older: boolean
}

const EA_HISTORY_PAGE_MAX = 500

/** context: the latest summary on, as the bot loads it; all: the newest page before `before`. */
export const eaHistoryQuery = z.object({
  scope: z.enum(['all', 'context']).default('all'),
  limit: z.coerce.number().int().min(1).max(EA_HISTORY_PAGE_MAX).default(200),
  before: z.coerce.number().int().positive().optional(),
})
export type EaHistoryQuery = z.output<typeof eaHistoryQuery>

/**
 * Entries the bot appends, oldest first, in one transaction. With `notify`, the batch's last
 * reply waits for the user as unseen, carrying the questions in `asks`.
 */
export const eaHistoryAppendInput = z.object({
  entries: z
    .array(z.object({ kind: z.enum(['message', 'chat', 'call']), message: eaLlmMessage }))
    .min(1)
    .max(100),
  notify: z.boolean().default(false),
  asks: z.array(z.number().int().positive()).max(16).default([]),
})
export type EaHistoryAppendInput = z.output<typeof eaHistoryAppendInput>

export interface EaHistoryAppended {
  ids: number[]
}

/** A compaction: `summary` stands in for every entry up to `through_id`. */
export const eaSummaryInput = z.object({
  summary: z.string().trim().min(1).max(CONTENT_MAX),
  through_id: z.number().int().positive(),
})

export interface EaHistoryCleared {
  cleared: number
}

export const EA_CHAT_TEXT_MAX = 8000

/** A message typed to the EA; its reply streams back as server-sent `EaChatEvent`s. */
export const eaChatInput = z.object({
  text: z.string().trim().min(1).max(EA_CHAT_TEXT_MAX),
  requestData: eaRequestData.nullish(),
  client_id: clientSendId,
})
export type EaChatInput = z.input<typeof eaChatInput>

/** The EA's typed reply as it streams: text as it is written, tool calls, then done or error. */
export type EaChatEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; id: string; name: string; arguments: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; summary: string; ok: boolean; text: string }
  /** The stored entries of this exchange, oldest first. */
  | { type: 'done'; ids: number[] }
  | { type: 'error'; title: string; detail: string }

/** The question the EA ends a request for confirmation with in the chat. */
export const EA_CONFIRM_QUESTION = 'Shall I go ahead?'

export const KEEP_AWAKE_MIN_S = 5
export const KEEP_AWAKE_MAX_S = 600
const WAKE_PHRASE = /^[\p{L}\p{N}' -]+$/u
const WAKE_WORDS_MAX = 4
export const FORM_OF_ADDRESS_MAX = 20
const FORM_OF_ADDRESS = /^[\p{L}\p{M}' .-]*$/u

/** Wake word: while on, the EA ignores speech until it hears the phrase. */
export const eaSettingsInput = z.object({
  wake_enabled: z.boolean(),
  wake_phrase: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(WAKE_PHRASE, 'Use letters, digits, spaces, hyphens and apostrophes')
    .refine((phrase) => phrase.split(/\s+/).length <= WAKE_WORDS_MAX, `Use at most ${String(WAKE_WORDS_MAX)} words`),
  keep_awake_seconds: z.number().int().min(KEEP_AWAKE_MIN_S).max(KEEP_AWAKE_MAX_S),
  /** With the wake word on, an open Seti joins the call asleep. */
  join_on_open: z.boolean().default(true),
  /** What the EA calls the user now and then, such as sir; empty for none, omitted to keep it. */
  form_of_address: z
    .string()
    .trim()
    .max(FORM_OF_ADDRESS_MAX)
    .regex(FORM_OF_ADDRESS, 'Use letters, spaces, hyphens, full stops and apostrophes')
    .optional(),
})
export type EaSettingsInput = z.output<typeof eaSettingsInput>

export interface EaSettings extends Omit<EaSettingsInput, 'form_of_address'> {
  form_of_address: string
  updated_at: string | null
}

export const EA_SETTINGS_DEFAULT: EaSettings = {
  wake_enabled: false,
  wake_phrase: 'Hey Seti',
  keep_awake_seconds: 30,
  join_on_open: true,
  form_of_address: '',
  updated_at: null,
}

/** The RTVI server message the bot sends when the wake state changes. */
export const eaWakeMessage = z.object({
  type: z.literal('ea-wake'),
  enabled: z.boolean(),
  awake: z.boolean(),
  phrase: z.string(),
  /** Asleep, the phrase is heard on the EA's host and no audio goes to speech to text. */
  local: z.boolean().optional(),
})
export type EaWake = Omit<z.output<typeof eaWakeMessage>, 'type'>

/** RTVI client messages the UI sends so a live call picks up changes made in Seti. */
export const EA_CLIENT_MESSAGES = {
  settingsChanged: 'ea-settings-changed',
  historyCleared: 'ea-history-cleared',
  /** Put the EA to sleep until its wake phrase; with the wake word off, for this call only. */
  sleep: 'ea-sleep',
  /** Wake the EA as if its phrase was said. */
  wake: 'ea-wake-up',
} as const
