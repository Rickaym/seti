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

/** What a start on each runtime says under the box, by whether the rules decide; null for none. */
const START_HINTS: Record<StoredRuntime, ((rulesDecide: boolean) => string) | null> = {
  claude: null,
  codex: (rulesDecide) =>
    rulesDecide ? 'Codex: sandboxed; asks unless your rules allow.' : 'Codex: sandboxed; asks before each call.',
  gemini: (rulesDecide) =>
    rulesDecide
      ? 'Gemini: sandboxed; cat, ls, grep run unasked.'
      : 'Gemini: sandboxed; cat, ls, grep unasked; rest asks.',
}

/** What a start on the runtime says under the box, or null where it says nothing. */
export const startHint = (runtime: StoredRuntime, rulesDecide: boolean): string | null =>
  START_HINTS[runtime]?.(rulesDecide) ?? null

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
  const named = models.map(({ id, label }) => ({ value: valueOf(runtime, id), label, runtime, model: id }))
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

/** The efforts the picked model takes; the default model keeps its own, so it offers none. */
export const effortsOf = (pick: RuntimePick, offers: readonly RuntimeOffer[]): readonly string[] =>
  offers.find((offer) => offer.runtime === pick.runtime)?.models.find((model) => model.id === pick.model)?.efforts ?? []

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
