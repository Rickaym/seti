import { z } from 'zod'
import { CODEX_EFFORTS, CODEX_MODELS } from './settings.js'
import { STORED_RUNTIMES, type StoredRuntime } from './stored.js'

/** Each runtime as people call it. */
export const RUNTIME_NAMES: Record<StoredRuntime, string> = { claude: 'Claude Code', codex: 'Codex' }

/** The runtime a new agent runs on when its start names neither a runtime nor a model. */
export const DEFAULT_RUNTIME: StoredRuntime = 'claude'

/**
 * The models and efforts a new agent may name on each runtime. Claude Code names none here, so
 * its agents run on the user's default model.
 */
const RUNTIME_PICKS: Record<StoredRuntime, { models: readonly string[]; efforts: readonly string[] }> = {
  claude: { models: [], efforts: [] },
  codex: { models: CODEX_MODELS, efforts: CODEX_EFFORTS },
}

/** Every model a new agent may name, on whichever runtime offers it. */
const PICKABLE_MODELS = [...CODEX_MODELS] as const

/** Every effort a new agent may name, on whichever runtime offers it. */
const PICKABLE_EFFORTS = [...CODEX_EFFORTS] as const

/** The runtimes that offer a model, in the order Seti lists them. */
export const runtimesOfModel = (model: string): StoredRuntime[] =>
  STORED_RUNTIMES.filter((runtime) => RUNTIME_PICKS[runtime].models.includes(model))

interface Picks {
  runtime?: StoredRuntime | undefined
  model?: string | undefined
  effort?: string | undefined
}

/** The runtime a start runs on: the one it names, else its model's, else the default. */
export function startRuntime({ runtime, model }: Picks): StoredRuntime {
  if (runtime !== undefined) {
    return runtime
  }
  const owners = model === undefined ? [] : runtimesOfModel(model)
  return owners.length === 1 && owners[0] !== undefined ? owners[0] : DEFAULT_RUNTIME
}

const unknownModel = (model: string) => `No runtime offers ${model}; a new agent may name ${PICKABLE_MODELS.join(', ')}`

/** Why a start's runtime, model and effort do not fit together, or null when they do. */
export function pickRefusal(picks: Picks): string | null {
  const owners = picks.model === undefined ? [] : runtimesOfModel(picks.model)
  if (picks.model !== undefined && owners.length === 0) {
    return unknownModel(picks.model)
  }
  if (picks.runtime === undefined && owners.length > 1) {
    return `More than one runtime offers ${String(picks.model)}; name the runtime too`
  }
  const runtime = startRuntime(picks)
  if (picks.model !== undefined && !owners.includes(runtime)) {
    const owner = RUNTIME_NAMES[owners[0] ?? DEFAULT_RUNTIME]
    return `${picks.model} runs on ${owner}, not on ${RUNTIME_NAMES[runtime]}`
  }
  if (picks.effort !== undefined && !RUNTIME_PICKS[runtime].efforts.includes(picks.effort)) {
    return `${RUNTIME_NAMES[runtime]} takes no effort here; name a model that has one`
  }
  return null
}

/**
 * The runtime a new agent runs on and its model and effort. A model alone picks its runtime; a
 * runtime left out with no model is Claude Code.
 */
export const runtimeFields = {
  runtime: z.enum(STORED_RUNTIMES).optional(),
  model: z.enum(PICKABLE_MODELS, { error: (issue) => unknownModel(String(issue.input)) }).optional(),
  effort: z.enum(PICKABLE_EFFORTS).optional(),
}

/** Adds the reason a start's runtime, model and effort disagree to a parse. */
export function checkPicks(picks: Picks, ctx: z.RefinementCtx): void {
  const refusal = pickRefusal(picks)
  if (refusal !== null) {
    ctx.addIssue({ code: 'custom', message: refusal })
  }
}

/** A runtime a new agent may start on now, with the models and efforts it may name there. */
export interface RuntimeOffer {
  runtime: StoredRuntime
  models: string[]
  efforts: string[]
}

/** What a runtime offers a new agent. */
export const offerOf = (runtime: StoredRuntime): RuntimeOffer => ({
  runtime,
  models: [...RUNTIME_PICKS[runtime].models],
  efforts: [...RUNTIME_PICKS[runtime].efforts],
})
