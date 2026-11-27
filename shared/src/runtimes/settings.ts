import { z } from 'zod'
import type { ClaudeCredentialMode } from '../sandbox.js'
import type { RuntimeOffer } from './picks.js'

/**
 * Codex as Seti runs it, which only the user changes: off until they turn it on, a program of
 * their own in place of the copy Seti installs, and whether Seti's permission rules answer a
 * Codex agent's calls without them.
 */
export interface CodexSettings {
  enabled: boolean
  /** A `codex` program the user names instead of Seti's own copy, as on a machine offline. */
  program: string | null
  /** On (the default), an allow rule or Seti's read-only list answers a call; off, the user does. */
  evaluator_decides: boolean
  /** The model and effort a new Codex agent starts with unless it picks its own. */
  default_model: string | null
  default_effort: string | null
}

export const CODEX_SETTINGS_DEFAULTS: CodexSettings = {
  enabled: false,
  program: null,
  evaluator_decides: true,
  default_model: null,
  default_effort: null,
}

/**
 * Gemini CLI as Seti runs it, which only the user changes: off until they turn it on, whether
 * Seti's permission rules answer a Gemini agent's calls without them, and the model a new Gemini
 * agent starts with unless it picks its own.
 */
export interface GeminiSettings {
  enabled: boolean
  evaluator_decides: boolean
  default_model: string | null
}

export const GEMINI_SETTINGS_DEFAULTS: GeminiSettings = { enabled: false, evaluator_decides: true, default_model: null }

/**
 * The models a Gemini agent may pick: those the pinned Gemini CLI knows and Google prices, and
 * the Gemini 4 models it reaches by explicit id.
 */
export const GEMINI_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.1-pro-preview',
  'gemini-4-carbon',
  'gemini-4-argon',
  'gemini-4-neon',
  'gemini-4-hydrogen',
] as const

/** A Gemini model as lists show it; no run against Google's own API has shown Gemini 4 yet. */
export const geminiModelLabel = (id: string): string => (id.startsWith('gemini-4-') ? `${id} (unproven)` : id)

/** A change to the Gemini settings, which only the user makes; a field left out stays. */
export const geminiSettingsInput = z.strictObject({
  enabled: z.boolean().optional(),
  evaluator_decides: z.boolean().optional(),
  default_model: z.enum(GEMINI_MODELS).nullable().optional(),
})
export type GeminiSettingsInput = z.input<typeof geminiSettingsInput>

/**
 * The models a Codex agent may pick. gpt-5.5 calls its tools directly; the newer ones call them
 * from scripts Codex's code mode host runs, and CI proves both shapes against a scripted model.
 */
export const CODEX_MODELS = ['gpt-5.5', 'gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6-luna'] as const

/** Models no run against OpenAI's own API has shown working yet, marked so in every list. */
const UNPROVEN: ReadonlySet<string> = new Set(['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6-luna'])

/** A Codex model as lists show it. */
export const codexModelLabel = (id: string): string => (UNPROVEN.has(id) ? `${id} (unproven)` : id)

/** Reasoning efforts of those models, without `ultra`, which hands work to subagents. */
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

const codexModel = z.enum(CODEX_MODELS)
const codexEffort = z.enum(CODEX_EFFORTS)

/** A change to the Codex settings, which only the user makes; a field left out stays. */
export const codexSettingsInput = z.strictObject({
  enabled: z.boolean().optional(),
  program: z
    .string()
    .trim()
    .max(1024)
    .refine((path) => path.startsWith('/'), 'Give the absolute path of the codex program')
    .nullable()
    .optional(),
  evaluator_decides: z.boolean().optional(),
  default_model: codexModel.nullable().optional(),
  default_effort: codexEffort.nullable().optional(),
})
export type CodexSettingsInput = z.input<typeof codexSettingsInput>

/**
 * Where Codex stands on this Seti: off, installing the pinned version, failed with a reason the
 * user can retry, on without an OpenAI key in the default credential, or ready to start agents.
 */
export const CODEX_STATES = ['off', 'installing', 'failed', 'no_key', 'ready'] as const
export type CodexState = (typeof CODEX_STATES)[number]

/**
 * Why a runtime's program cannot run: the download failed, a checksum did not match, the pin has
 * no build for this machine, the disk refused the write, Seti's copy is not there, or the program
 * the user named is missing or another version.
 */
export const INSTALL_FAILURES = ['network', 'checksum', 'platform', 'disk', 'missing', 'program'] as const
export type InstallFailure = (typeof INSTALL_FAILURES)[number]

/** The Codex runtime as Settings shows it; the key's state is counts and names, never a value. */
export interface CodexStatus {
  state: CodexState
  /** Why Codex cannot run, present only in the failed state. */
  failure: { reason: InstallFailure; message: string } | null
  /** The version the program agents start reports or was verified as, when there is one. */
  version: string | null
  /** The version this Seti is built and tested against, which it installs itself. */
  pinned: string
  /** The program new Codex agents start: Seti's own copy, or the one the user named. */
  binary: string | null
  settings: CodexSettings
  /** Credentials holding a connection with a header on OpenAI's API, which a Codex agent needs. */
  keyed: string[]
  /** The one connection with an OpenAI key that the default credential lacks, by name, if one. */
  keyElsewhere: string | null
  /** The date of the price table a Codex agent's estimated cost comes from. */
  pricesAsOf: string
}

/** The Gemini runtime as Settings shows it, in Codex's states; the key's state is names only. */
export interface GeminiStatus {
  state: CodexState
  failure: { reason: InstallFailure; message: string } | null
  /** The pinned Gemini CLI version, which Seti installs and checks itself. */
  pinned: string
  settings: GeminiSettings
  /** Credentials holding a connection with a header on Google's Gemini API. */
  keyed: string[]
  /** The one connection with a Gemini key that the default credential lacks, by name, if one. */
  keyElsewhere: string | null
  /** The date of the price table a Gemini agent's estimated cost comes from. */
  pricesAsOf: string
}

/** Claude Code as Settings shows it:its program and version, the defaults it names, no value. */
export interface ClaudeStatus {
  /** The program agents run: SETI_CLAUDE_BIN, a claude on the PATH, or the Agent SDK's own. */
  program: string
  /** The version the program reports, when it ran. */
  version: string | null
  /** The model and effort Claude Code's user settings name; null for its own defaults. */
  default_model: string | null
  default_effort: string | null
  /** What sandboxed agents sign in with: the token in Credentials, this machine's login, or none. */
  sign_in: ClaudeCredentialMode
}

/**
 * Each runtime as `GET /api/runtimes` answers, and the runtimes a new agent may start on now:
 * Claude Code always, Codex only while it is ready.
 */
export interface RuntimesStatus {
  claude: ClaudeStatus
  codex: CodexStatus
  gemini: GeminiStatus
  offers: RuntimeOffer[]
}
