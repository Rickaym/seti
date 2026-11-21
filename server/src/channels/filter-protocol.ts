import type { ModuleLimits } from '../quickjs/engine.js'

/** What a filter receives: the event as the sender produced it, a few headers and the payload. */
export interface FilterEventInput {
  event: string
  action: string | null
  title: string
  link: string | null
  detail: string
  headers: Record<string, string>
  payload: unknown
}

/** Server to filter worker: one run, numbered by the pool. */
export interface FilterRequest {
  runId?: number
  script: string
  input: FilterEventInput
  limits: ModuleLimits
}

/** What the filter returned, with its type as the engine saw it; JSON alone loses undefined. */
export interface FilterReturn {
  kind: string
  value: unknown
}

export type FilterReply = { ok: true; value: unknown; logs: string[] } | { ok: false; error: string; logs: string[] }
