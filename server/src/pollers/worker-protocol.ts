import type { EngineInput, EngineLimits } from './engine.js'
import type { ReadOutput } from './items.js'

/** What the worker's fetch may reach and how much it reads; Seti's guards apply in the worker. */
interface FetchSettings {
  /** The sandbox allowlist plus the poller's extra hosts. */
  allowed: string[]
  responseMaxBytes: number
  runResponseMaxBytes: number
  requestBodyMaxBytes: number
  timeoutMs: number
  allowLoopback: boolean
}

/** Server to worker: one run, as plain values any transport, such as a process pipe, can carry. */
export interface RunRequest {
  runId: number
  script: string
  input: EngineInput
  limits: EngineLimits
  fetch: FetchSettings
  fingerprintFields: string[]
  /** Name and value of each secret this poller may use, sent for this run only. */
  secrets: [string, string][]
}

/** A finished run, with every secret value already replaced. */
export type RunResult = { ok: true; output: ReadOutput; logs: string[] } | { ok: false; error: string; logs: string[] }

/** Worker to server: ready once loaded, then one reply per run; `retire` asks for a new worker. */
export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'result'; runId: number; result: RunResult; retire?: true }
  | { type: 'error'; runId: number; error: string }
