import { DEFAULT_RUNTIME, RUNTIME_NAMES, type RuntimeOffer, type StoredRuntime } from '@seti/shared'

/** The model a new agent runs on, which sets its runtime, and the effort that runtime may take. */
export interface RuntimePick {
  runtime: StoredRuntime
  /** Null runs the runtime's default model. */
  model: string | null
  /** Null runs the runtime's default effort. */
  effort: string | null
}

/** Today's default: Claude Code on the user's default model. */
export const DEFAULT_PICK: RuntimePick = { runtime: DEFAULT_RUNTIME, model: null, effort: null }

export const CODEX_HINT = 'Codex: sandboxed, asks before every command and edit.'

/** One option of the model selector, grouped under its runtime. */
export interface ModelOption {
  value: string
  label: string
  runtime: StoredRuntime
  model: string | null
}

/** One heading of the model selector and its options. */
export interface ModelGroup {
  runtime: StoredRuntime
  label: string
  options: ModelOption[]
}

const valueOf = (runtime: StoredRuntime, model: string | null) => `${runtime}:${model ?? ''}`

/** The selector's value for a pick. */
export const pickValue = (pick: RuntimePick): string => valueOf(pick.runtime, pick.model)

/** The default runtime leads with its default model; other runtimes list only their models. */
function optionsOf({ runtime, models }: RuntimeOffer): ModelOption[] {
  const named = models.map((model) => ({ value: valueOf(runtime, model), label: model, runtime, model }))
  if (runtime !== DEFAULT_RUNTIME) {
    return named
  }
  return [{ value: valueOf(runtime, null), label: 'Default', runtime, model: null }, ...named]
}

/** The selector's groups, in the order the server offers the runtimes. */
export const modelGroups = (offers: readonly RuntimeOffer[]): ModelGroup[] =>
  offers
    .map((offer) => ({ runtime: offer.runtime, label: RUNTIME_NAMES[offer.runtime], options: optionsOf(offer) }))
    .filter((group) => group.options.length > 0)

/** The pick a selector value stands for, on the runtime's default effort; null when not offered. */
export function pickOf(value: string, offers: readonly RuntimeOffer[]): RuntimePick | null {
  const option = modelGroups(offers)
    .flatMap((group) => group.options)
    .find((each) => each.value === value)
  return option === undefined ? null : { runtime: option.runtime, model: option.model, effort: null }
}

/** The efforts the pick's runtime offers, none for a runtime that takes no effort. */
export const effortsOf = (pick: RuntimePick, offers: readonly RuntimeOffer[]): readonly string[] =>
  offers.find((offer) => offer.runtime === pick.runtime)?.efforts ?? []

/** The pick while its model is still offered, else the default, as when Codex stops being ready. */
export function offeredPick(pick: RuntimePick, offers: readonly RuntimeOffer[]): RuntimePick {
  const still = pickOf(pickValue(pick), offers)
  if (still === null) {
    return DEFAULT_PICK
  }
  const keepsEffort = pick.effort !== null && effortsOf(pick, offers).includes(pick.effort)
  return keepsEffort ? { ...still, effort: pick.effort } : still
}

/** The request fields for a pick; the default needs none, so its start body stays as it was. */
export function pickFields(pick: RuntimePick): { runtime?: StoredRuntime; model?: string; effort?: string } {
  if (pick.runtime === DEFAULT_RUNTIME && pick.model === null && pick.effort === null) {
    return {}
  }
  return {
    runtime: pick.runtime,
    ...(pick.model === null ? {} : { model: pick.model }),
    ...(pick.effort === null ? {} : { effort: pick.effort }),
  }
}
