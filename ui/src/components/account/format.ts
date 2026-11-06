import type { AccountIdentity, AccountStatus, UsageWindow } from '@seti/shared'
import { durationLabel } from '@/lib/time'

const WARN_PERCENT = 80
const DANGER_PERCENT = 95

/** A plan name as Claude shows it, such as Max for `max` or `claude_max`. */
export function planName(subscription: string | null | undefined): string {
  const plan = subscription?.replace(/^claude[\s_]+/i, '') ?? ''
  return plan === '' ? 'Claude' : `${plan.charAt(0).toUpperCase()}${plan.slice(1)}`
}

export const planLabel = (account: AccountIdentity | null): string => planName(account?.subscription_type)

const ESTIMATE = 'Estimate at API prices, across all its sessions'

/** How to read an agent's cost: notional on a subscription plan, else an estimate. */
export function costBasis(status: Pick<AccountStatus, 'account' | 'health'> | undefined): string {
  const account = status?.account ?? null
  if ((account?.subscription_type ?? null) === null || status?.health.state === 'api_key') {
    return ESTIMATE
  }
  return `Notional: your ${planLabel(account)} plan covers it; this is the API price`
}

export const percent = (value: number | null) => (value === null ? '-' : `${String(Math.round(value))}%`)

export type Level = 'normal' | 'warning' | 'danger'

export function level(value: number | null): Level {
  if (value === null || value < WARN_PERCENT) {
    return 'normal'
  }
  return value >= DANGER_PERCENT ? 'danger' : 'warning'
}

const FIVE_HOUR = 'five_hour'
const WEEKLY = 'seven_day'

export interface UsageFill {
  percent: number
  level: Level
}

function fillOf(w: UsageWindow | undefined): UsageFill | null {
  const used = w?.utilization ?? null
  return used === null ? null : { percent: Math.min(100, Math.max(0, used)), level: level(used) }
}

/** One bar: the 5-hour fill over a dimmed weekly fill; plus any other window running hot. */
export interface UsageMeter {
  primary: UsageFill | null
  weekly: UsageFill | null
  weeklyAbove: boolean
  hottest: { window: UsageWindow; fill: UsageFill } | null
}

export function usageMeter(windows: readonly UsageWindow[]): UsageMeter | null {
  const fiveHour = windows.find((w) => w.key === FIVE_HOUR)
  const weekly = windows.find((w) => w.key === WEEKLY)
  const hot = windows
    .filter((w) => w !== fiveHour && w !== weekly && (w.utilization ?? 0) >= WARN_PERCENT)
    .toSorted((a, b) => (b.utilization ?? 0) - (a.utilization ?? 0))[0]
  const hotFill = fillOf(hot)
  const primary = fillOf(fiveHour)
  const weeklyFill = fillOf(weekly)
  if (primary === null && weeklyFill === null && hotFill === null) {
    return null
  }
  const weeklyAbove = weeklyFill !== null && weeklyFill.percent > (primary?.percent ?? 0)
  const hottest = hot === undefined || hotFill === null ? null : { window: hot, fill: hotFill }
  return { primary, weekly: weeklyFill, weeklyAbove, hottest }
}

export function resetClock(at: Date, ms: number): string {
  return at.toLocaleString(undefined, {
    ...(ms > 86_400_000 ? { weekday: 'short' } : {}),
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function resetText(iso: string | null, now: number = Date.now()): string {
  if (iso === null) {
    return 'no reset time'
  }
  const at = new Date(iso)
  const ms = at.getTime() - now
  if (ms <= 0) {
    return 'resets now'
  }
  return `resets in ${durationLabel(ms)} (${resetClock(at, ms)})`
}

const windowName = (w: UsageWindow) => (w.label === '' ? w.key : w.label)

/** The 5-hour and weekly windows, then any other window running hot, as the status bar draws them. */
function meterWindows(windows: readonly UsageWindow[]): UsageWindow[] {
  const known = [FIVE_HOUR, WEEKLY].flatMap((key) => windows.filter((w) => w.key === key && w.utilization !== null))
  const hot = windows
    .filter((w) => !known.includes(w) && (w.utilization ?? 0) >= WARN_PERCENT)
    .toSorted((a, b) => (b.utilization ?? 0) - (a.utilization ?? 0))
    .slice(0, 1)
  return [...known, ...hot]
}

const lowerFirst = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`

/** The meter in words, as in "5-hour 64%, weekly 38%, 5-hour resets 14:30". */
export function usageWords(windows: readonly UsageWindow[], now: number = Date.now()): string {
  const shown = meterWindows(windows)
  const parts = shown.map((w) => `${lowerFirst(windowName(w))} ${percent(w.utilization)}`)
  const [first] = shown
  const reset = first?.resets_at ?? null
  const ms = reset === null ? 0 : Date.parse(reset) - now
  if (first !== undefined && reset !== null && ms > 0) {
    parts.push(`${lowerFirst(windowName(first))} resets ${resetClock(new Date(reset), ms)}`)
  }
  return parts.join(', ')
}

/** One line per window the meter draws, with its reset. */
export function usageLines(windows: readonly UsageWindow[], now: number = Date.now()): string[] {
  return meterWindows(windows).map(
    (w) => `${windowName(w)}: ${percent(w.utilization)}, ${resetText(w.resets_at, now)}.`,
  )
}

export const clockTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

export const authSource = (account: AccountIdentity) =>
  account.token_source ?? account.api_key_source ?? 'Claude Code login'
