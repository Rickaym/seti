import { z } from 'zod'

const ONE_MILLION = /\[1m\]$/i

/** A model id as people say it: claude-opus-5-5 reads "Opus 5.5"; an unknown shape stays as is. */
export function modelLabel(id: string): string {
  const start = id.indexOf('claude-')
  if (start === -1) {
    return id
  }
  const parts = id
    .slice(start + 'claude-'.length)
    .replace(ONE_MILLION, '')
    .split('-')
  const family = parts.find((part) => /^[a-z]+$/i.test(part))
  if (family === undefined) {
    return id
  }
  const version = parts.filter((part) => /^\d{1,2}$/.test(part)).join('.')
  const name = `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()}`
  const label = version === '' ? name : `${name} ${version}`
  return ONE_MILLION.test(id) ? `${label} 1M` : label
}

/** A model id Claude Code reports; nothing else may reach the /model command Seti sends. */
const modelId = z
  .string()
  .max(120)
  .regex(/^[\w.:/@[\]-]+$/, 'not a model id')

/**
 * Claude Code's notice that a safeguard refused a request and it retried on a fallback model,
 * as the Agent SDK's SDKModelRefusalFallbackMessage types it. Scope `session` (or absent, from
 * older CLIs) moves the whole session to the fallback; `local` only one subagent's response.
 */
export const modelFallbackMessage = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('model_refusal_fallback'),
  uuid: z.string().optional(),
  scope: z.string().optional(),
  original_model: z.string(),
  fallback_model: z.string(),
  request_id: z.string().nullable(),
  api_refusal_category: z.string().nullish(),
  api_refusal_explanation: z.string().nullish(),
  api_refusal_cyber_verification: z.looseObject({ type: z.string(), url: z.string().optional() }).nullish(),
  content: z.string(),
})
export type ModelFallbackMessage = z.infer<typeof modelFallbackMessage>

/** The fallback model an agent's session runs on until a later session start reports another. */
export interface ModelFallback {
  original_model: string
  fallback_model: string
  /** The refusal category, such as cyber; null when Claude Code gave none. */
  category: string | null
  request_id: string | null
  at: string
}

/** The message as a model fallback notice, or null for any other message. */
export function modelFallbackOf(message: unknown): ModelFallbackMessage | null {
  const parsed = modelFallbackMessage.safeParse(message)
  return parsed.success ? parsed.data : null
}

/** Whether the fallback moved the whole session rather than one subagent's response. */
export const movesSession = (m: Pick<ModelFallbackMessage, 'scope'>): boolean => m.scope !== 'local'

/** Why Claude Code switched, such as "a cyber safeguard flagged a request". */
export const fallbackReason = (category: string | null | undefined): string =>
  category === null || category === undefined || category === ''
    ? 'a safeguard flagged a request'
    : `a ${category} safeguard flagged a request`

/** The sentence a notice, a push and the audit log share. */
export function fallbackSentence(f: Pick<ModelFallback, 'original_model' | 'fallback_model' | 'category'>): string {
  const from = modelLabel(f.original_model)
  const to = modelLabel(f.fallback_model)
  return `Claude Code switched this agent from ${from} to ${to} after ${fallbackReason(f.category)}.`
}

/** Whether the id may go into a /model command: a plain model id, never other words. */
export const switchableModel = (id: string): boolean => modelId.safeParse(id).success

/** The message that moves the session back to the model it fell back from. */
export const switchBackPrompt = (originalModel: string): string => `/model ${modelId.parse(originalModel)}`

const baseModel = (id: string) => id.replace(ONE_MILLION, '')

/** Whether a session start on `model` ends the fallback: it reports another model. */
export const endsFallback = (fallback: Pick<ModelFallback, 'fallback_model'>, model: string): boolean =>
  baseModel(model) !== baseModel(fallback.fallback_model)
