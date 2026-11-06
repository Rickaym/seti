import { z } from 'zod'
import { lenientArray, opaque, orDefault, type ResponseSchema } from './lenient.js'

export const accountRefreshInput = z.object({}).strict()

export type AccountHealthState = 'ok' | 'api_key' | 'logged_out' | 'error'

export interface AccountHealth {
  state: AccountHealthState
  message: string
}

/** What Claude Code reports about the login it would use for Seti's agents. */
export interface AccountIdentity {
  email: string | null
  organization: string | null
  subscription_type: string | null
  token_source: string | null
  api_key_source: string | null
  api_provider: string | null
}

/** One plan rate-limit window; utilization is a percentage from 0 to 100. */
export interface UsageWindow {
  key: string
  label: string
  utilization: number | null
  resets_at: string | null
}

/** mixed: the usage API, with windows a later agent rate limit event reported taking precedence. */
export interface PlanUsage {
  source: 'usage_api' | 'task_stream' | 'mixed'
  observed_at: string
  windows: UsageWindow[]
}

export interface RateLimitObservation {
  task_id: string
  task_title: string
  at: string
  status: string
  rate_limit_type: string | null
  windows: UsageWindow[]
}

/** The latest turn that failed on the login or billing, e.g. authentication_failed. */
export interface TaskLoginError {
  task_id: string
  task_title: string
  at: string
  error: string
  message: string | null
}

/** A Claude login Seti keeps sealed so the user can switch to it; never its tokens. */
export interface ClaudeLogin {
  id: string
  name: string
  email: string | null
  organization: string | null
  plan: string | null
  created_at: string
  updated_at: string
}

/** Who Claude Code is signed in as, by its own profile data, when no saved login matches. */
export interface UnsavedLogin {
  email: string | null
  organization: string | null
}

export interface ClaudeLogins {
  accounts: ClaudeLogin[]
  /** The saved login Claude Code on this machine uses now; null when signed out or unsaved. */
  active_id: string | null
  unsaved: UnsavedLogin | null
}

export const NO_LOGINS: ClaudeLogins = { accounts: [], active_id: null, unsaved: null }

export const LOGIN_NAME_MAX = 40

export const loginNameInput = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Name the login, such as Work')
      .max(LOGIN_NAME_MAX, `Keep the name to ${String(LOGIN_NAME_MAX)} characters`),
  })
  .strict()
export type LoginNameInput = z.input<typeof loginNameInput>

export const loginParams = z.object({ id: z.string().min(1).max(64) })

/** A sign-in Seti started with `claude auth login`: the page to open and where to paste the code. */
export interface SignInStart {
  id: string
  url: string
}

export const signInCodeInput = z
  .object({
    code: z
      .string()
      .trim()
      .min(8, 'Paste the whole code the sign-in page shows')
      .max(1024)
      .regex(/^[\x21-\x7E]+$/, 'The code is printable text with no spaces'),
  })
  .strict()
export type SignInCodeInput = z.input<typeof signInCodeInput>

export interface AccountStatus {
  account: AccountIdentity | null
  logins: ClaudeLogins
  health: AccountHealth
  usage: PlanUsage | null
  usage_note: string | null
  rate_limit_event: RateLimitObservation | null
  task_error: TaskLoginError | null
  fetched_at: string
}

const usageWindowSchema = z.object({
  key: z.string(),
  label: orDefault('usage label', z.string(), ''),
  utilization: orDefault('usage utilization', z.number().nullable(), null),
  resets_at: orDefault('usage resets_at', z.string().nullable(), null),
})

const usageWindows = lenientArray('usage window', usageWindowSchema)

const UNKNOWN_HEALTH: AccountHealth = { state: 'error', message: 'Seti could not read the login state.' }

const claudeLoginSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: orDefault('login email', z.string().nullable(), null),
  organization: orDefault('login organization', z.string().nullable(), null),
  plan: orDefault('login plan', z.string().nullable(), null),
  created_at: z.string(),
  updated_at: z.string(),
})

export const claudeLoginsSchema = z.object({
  accounts: lenientArray('saved login', claudeLoginSchema),
  active_id: orDefault('active login', z.string().nullable(), null),
  unsaved: opaque<UnsavedLogin>('unsaved login'),
}) satisfies ResponseSchema<ClaudeLogins>

export const accountStatusSchema = z.object({
  account: opaque<AccountIdentity>('account'),
  logins: orDefault('logins', claudeLoginsSchema, NO_LOGINS),
  health: orDefault(
    'health',
    z.object({ state: z.enum(['ok', 'api_key', 'logged_out', 'error']), message: z.string() }),
    UNKNOWN_HEALTH,
  ),
  usage: orDefault<PlanUsage | null>(
    'usage',
    z
      .object({
        source: z.enum(['usage_api', 'task_stream', 'mixed']),
        observed_at: z.string(),
        windows: usageWindows,
      })
      .nullable(),
    null,
  ),
  usage_note: orDefault('usage_note', z.string().nullable(), null),
  rate_limit_event: orDefault<RateLimitObservation | null>(
    'rate_limit_event',
    z
      .object({
        task_id: z.string(),
        task_title: z.string(),
        at: z.string(),
        status: z.string(),
        rate_limit_type: z.string().nullable(),
        windows: usageWindows,
      })
      .nullable(),
    null,
  ),
  task_error: opaque<TaskLoginError>('task_error'),
  fetched_at: z.string(),
}) satisfies ResponseSchema<AccountStatus>
