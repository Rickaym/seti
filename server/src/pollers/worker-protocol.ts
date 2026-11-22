import type { PoolMessage } from '../quickjs/pool.js'
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

export type WorkerMessage = PoolMessage<RunResult>

/** One run as the pool takes it; the pool numbers it. */
export type PollRequest = Omit<RunRequest, 'runId'>
