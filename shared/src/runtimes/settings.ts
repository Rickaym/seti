import { z } from 'zod'
import { STORED_RUNTIMES } from './stored.js'

/**
 * Codex as Seti runs it, which only the user changes: off until they turn it on, the program
 * agents start, and whether Seti's permission rules answer a Codex agent's calls without them.
 */
export interface CodexSettings {
  enabled: boolean
  /** The absolute path of the `codex` program agents start; null until the user names it. */
  program: string | null
  /** On, an allow rule or Seti's read-only list answers a call; off, the user answers every one. */
  evaluator_decides: boolean
  /** The model and effort a new Codex agent starts with unless it picks its own. */
  default_model: string | null
  default_effort: string | null
}

export const CODEX_SETTINGS_DEFAULTS: CodexSettings = {
  enabled: false,
  program: null,
  evaluator_decides: false,
  default_model: null,
  default_effort: null,
}

/**
 * The models a Codex agent may pick: those the pinned Codex sends its tools for, as CI proves.
 * Newer models in its catalog send none from the client, so no test shows them working.
 */
export const CODEX_MODELS = ['gpt-5.5'] as const

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

/** The runtime a new agent runs on, and the model and effort only a Codex agent picks here. */
export const runtimeFields = {
  runtime: z.enum(STORED_RUNTIMES).default('claude'),
  model: codexModel.optional(),
  effort: codexEffort.optional(),
}

/** Refuses a model or effort for an agent that is not a Codex agent. */
export const onlyCodexPicks = (input: {
  runtime: string
  model?: string | undefined
  effort?: string | undefined
}): boolean => input.runtime === 'codex' || (input.model === undefined && input.effort === undefined)

export const ONLY_CODEX_PICKS = 'Only a Codex agent picks a model and effort here'

/**
 * Where Codex stands on this Seti: off, on with no program named, a program that is not there or
 * not the pinned version, or ready to start agents.
 */
export const CODEX_STATES = ['off', 'not_set_up', 'missing', 'update_needed', 'ready'] as const
export type CodexState = (typeof CODEX_STATES)[number]

/** The Codex runtime as Settings shows it; the key's state is counts, never a value. */
export interface CodexStatus {
  state: CodexState
  /** The version the program reports, when it ran. */
  version: string | null
  /** The version this Seti is built and tested against. */
  pinned: string
  settings: CodexSettings
  /** Connections that put a header on OpenAI's API, which a Codex agent's credential carries. */
  keys: number
  /** The date of the price table a Codex agent's estimated cost comes from. */
  pricesAsOf: string
}
