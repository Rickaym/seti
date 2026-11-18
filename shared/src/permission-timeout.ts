import { z } from 'zod'
import { orDefault, type ResponseSchema } from './lenient.js'

/** Minutes a permission request waits for an answer before Seti denies it; 0 never denies. */
export const PERMISSION_TIMEOUT_MINUTES = [0, 15, 60, 240, 1440] as const
export type PermissionTimeoutMinutes = (typeof PERMISSION_TIMEOUT_MINUTES)[number]
export const DEFAULT_PERMISSION_TIMEOUT_MINUTES: PermissionTimeoutMinutes = 60

const MINUTE_MS = 60_000
const WARN_SHARE = 0.2
const WARN_MIN_MS = 5 * MINUTE_MS

/** The install-wide timeout of permission requests, which only the user changes. */
export interface PermissionTimeoutSettings {
  request_timeout_minutes: PermissionTimeoutMinutes
  /** Null while the default applies. */
  updated_at: string | null
}

const minutes = z.union([z.literal(0), z.literal(15), z.literal(60), z.literal(240), z.literal(1440)])

export const permissionTimeoutInput = z.object({ request_timeout_minutes: minutes })
export type PermissionTimeoutInput = z.infer<typeof permissionTimeoutInput>

export const permissionTimeoutSchema = z.object({
  request_timeout_minutes: orDefault<PermissionTimeoutMinutes>(
    'request_timeout_minutes',
    minutes,
    DEFAULT_PERMISSION_TIMEOUT_MINUTES,
  ),
  updated_at: orDefault('updated_at', z.string().nullable(), null),
}) satisfies ResponseSchema<PermissionTimeoutSettings>

/** A timeout in words: "Off", "15 min", "1 h", "24 h". */
export function timeoutLabel(timeoutMinutes: number): string {
  if (timeoutMinutes <= 0) {
    return 'Off'
  }
  return timeoutMinutes % 60 === 0 ? `${String(timeoutMinutes / 60)} h` : `${String(timeoutMinutes)} min`
}

/** When a request raised at `createdAt` is denied; null while the timeout is off. */
export const timeoutAt = (createdAt: string, timeoutMinutes: number): string | null =>
  timeoutMinutes <= 0 ? null : new Date(Date.parse(createdAt) + timeoutMinutes * MINUTE_MS).toISOString()

interface Timed {
  created_at: string
  timeout_at: string | null
}

/** The whole minutes a request was given, from its two times. */
export const timeoutMinutesOf = (request: Timed): number =>
  request.timeout_at === null
    ? 0
    : Math.round((Date.parse(request.timeout_at) - Date.parse(request.created_at)) / MINUTE_MS)

/**
 * When a request counts as about to time out: after four fifths of its time, and at least five
 * minutes before the end; null while it has no timeout.
 */
export function timeoutWarnAt(request: Timed): number | null {
  if (request.timeout_at === null) {
    return null
  }
  const end = Date.parse(request.timeout_at)
  const span = end - Date.parse(request.created_at)
  return end - Math.max(span * WARN_SHARE, WARN_MIN_MS)
}

/** Whether the request is about to time out at `at`. */
export function timesOutSoon(request: Timed, at: number = Date.now()): boolean {
  const warnAt = timeoutWarnAt(request)
  return warnAt !== null && at >= warnAt
}

/** What the agent reads when nobody answered its request in time. */
export const timedOutMessage = (timeoutMinutes: number): string =>
  `No answer within ${timeoutLabel(timeoutMinutes)}, so Seti denied this automatically; ` +
  'this is not a judgement on the action. Carry on without it if you can, or ask again when it is needed.'
