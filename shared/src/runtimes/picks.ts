import { z } from 'zod'
import { CODEX_EFFORTS, CODEX_MODELS, codexModelLabel, GEMINI_MODELS, geminiModelLabel } from './settings.js'
import { STORED_RUNTIMES, type StoredRuntime } from './stored.js'

/** Each runtime as people call it. */
export const RUNTIME_NAMES: Record<StoredRuntime, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
}

/** The runtime a new agent runs on when its start names neither a runtime nor a model. */
export const DEFAULT_RUNTIME: StoredRuntime = 'claude'

/** The reasoning efforts a start may name, by the names both runtimes use. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/** The effort level a stored value names, or null for none or an unknown one. */
export const effortLevel = (value: string | null): EffortLevel | null =>
  EFFORT_LEVELS.find((level) => level === value) ?? null

/** A model a new agent may name, as the selector shows it, with the efforts it takes. */
export interface OfferedModel {
  id: string
  label: string
  efforts: string[]
}

/** A runtime a new agent may start on, its models, and the efforts its default model takes. */
export interface RuntimeOffer {
  runtime: StoredRuntime
  models: OfferedModel[]
  default_efforts: string[]
}

/** Claude Code's stable aliases, offered until a probe reports the account's own models. */
export const CLAUDE_ALIASES = ['opus', 'sonnet', 'haiku'] as const

/** A Claude Code model as a capability probe reports it. */
export interface ReportedModel {
  value: string
  display_name: string
  efforts?: string[] | undefined
}

const DEFAULT_MODEL = 'default'

const aliasModel = (id: string): OfferedModel => ({
  id,
  label: `${id.charAt(0).toUpperCase()}${id.slice(1)}`,
  efforts: [],
})

/** Claude Code's offer: the models its last probe reported, else its stable aliases. */
export function claudeOffer(reported: readonly ReportedModel[] | null): RuntimeOffer {
  if (reported === null || reported.length === 0) {
    return { runtime: 'claude', models: CLAUDE_ALIASES.map(aliasModel), default_efforts: [] }
  }
  return {
    runtime: 'claude',
    models: reported
      .filter((model) => model.value !== DEFAULT_MODEL)
      .map((model) => ({ id: model.value, label: model.display_name, efforts: model.efforts ?? [] })),
    default_efforts: reported.find((model) => model.value === DEFAULT_MODEL)?.efforts ?? [],
  }
}

/** Codex's offer: the models Seti proves it with, each with every effort. */
export const codexOffer = (): RuntimeOffer => ({
  runtime: 'codex',
  models: CODEX_MODELS.map((id) => ({ id, label: codexModelLabel(id), efforts: [...CODEX_EFFORTS] })),
  default_efforts: [...CODEX_EFFORTS],
})

/** Gemini CLI's offer: its models by explicit id; Seti sets no effort on them. */
export const geminiOffer = (): RuntimeOffer => ({
  runtime: 'gemini',
  models: GEMINI_MODELS.map((id) => ({ id, label: geminiModelLabel(id), efforts: [] })),
  default_efforts: [],
})

/** The runtimes that offer a model, in the order they are offered. */
export const runtimesOfModel = (model: string, offers: readonly RuntimeOffer[]): StoredRuntime[] =>
  offers.filter((offer) => offer.models.some((each) => each.id === model)).map((offer) => offer.runtime)

interface Picks {
  runtime?: StoredRuntime | undefined
  model?: string | undefined
  effort?: string | undefined
}

/** The runtime a start runs on: the one it names, else its model's, else the default. */
export function startRuntime({ runtime, model }: Picks, offers: readonly RuntimeOffer[]): StoredRuntime {
  if (runtime !== undefined) {
    return runtime
  }
  const owners = model === undefined ? [] : runtimesOfModel(model, offers)
  return owners.length === 1 && owners[0] !== undefined ? owners[0] : DEFAULT_RUNTIME
}

const allModels = (offers: readonly RuntimeOffer[]) => offers.flatMap((offer) => offer.models.map((each) => each.id))

/** The efforts the picked model takes, or the runtime's default model when none is picked. */
function effortsFor(picks: Picks, runtime: StoredRuntime, offers: readonly RuntimeOffer[]): string[] {
  const offer = offers.find((each) => each.runtime === runtime)
  if (picks.model === undefined) {
    return offer?.default_efforts ?? []
  }
  return offer?.models.find((each) => each.id === picks.model)?.efforts ?? []
}

/** Why a start's runtime, model and effort do not fit what is offered, or null when they do. */
export function pickRefusal(picks: Picks, offers: readonly RuntimeOffer[]): string | null {
  const owners = picks.model === undefined ? [] : runtimesOfModel(picks.model, offers)
  if (picks.model !== undefined && owners.length === 0) {
    return `No runtime offers ${picks.model}; a new agent may name ${allModels(offers).join(', ')}`
  }
  if (picks.runtime === undefined && owners.length > 1) {
    return `More than one runtime offers ${String(picks.model)}; name the runtime too`
  }
  const runtime = startRuntime(picks, offers)
  if (picks.model !== undefined && !owners.includes(runtime)) {
    return `${picks.model} runs on ${RUNTIME_NAMES[owners[0] ?? DEFAULT_RUNTIME]}, not on ${RUNTIME_NAMES[runtime]}`
  }
  const efforts = effortsFor(picks, runtime, offers)
  if (picks.effort !== undefined && !efforts.includes(picks.effort)) {
    const what = picks.model ?? `${RUNTIME_NAMES[runtime]}'s default model`
    return `${what} takes no ${picks.effort} effort here; it takes ${efforts.length === 0 ? 'none' : efforts.join(', ')}`
  }
  return null
}

/** A model id as a runtime names it, an alias or a full id; what is offered is checked on start. */
const modelId = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[\w.:/@[\]-]+$/, 'not a model id')

/**
 * The runtime a new agent runs on and its model and effort. A model alone picks its runtime; a
 * start naming neither runs on Claude Code with the user's default model.
 */
export const runtimeFields = {
  runtime: z.enum(STORED_RUNTIMES).optional(),
  model: modelId.optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
}
