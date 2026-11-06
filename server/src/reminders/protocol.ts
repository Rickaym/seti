/** The line the runner writes once locked down, just before it loads the script. */
export const STARTED = '{"started":true}'

/** What a reminder script receives each run. */
export interface ReminderContext {
  now: string
  lastRunAt: string | null
  lastOutput: string | null
  state: unknown
}

export interface RunnerLimits {
  messageMaxChars: number
  stateMaxBytes: number
  logLines: number
  logLineChars: number
  errorChars: number
}

/** Server to runner, as one JSON document on stdin. */
export interface RunnerRequest {
  script: string
  input: ReminderContext
  limits: RunnerLimits
}

/** Runner to server, as the last JSON line on stdout; state is absent when the script kept it. */
export type RunnerReply =
  { ok: true; message: string | null; state?: unknown; logs: string[] } | { ok: false; error: string; logs: string[] }
