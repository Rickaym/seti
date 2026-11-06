import type { EaHealth, EaNotRunning } from '@seti/shared'
import { useCallback, useEffect, useState } from 'react'
import { startPolling } from '@/lib/poll-loop'
import { apiErrorOf } from './ice'

const HEALTH_PATH = '/api/ea/health'

const POLL_MS = 15_000
const TIMEOUT_MS = 5_000

export type HealthState =
  { status: 'loading' } | { status: 'up'; health: EaHealth } | { status: 'down'; reason: string }

async function readHealth(): Promise<HealthState> {
  try {
    const res = await fetch(HEALTH_PATH, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) {
      const error = await apiErrorOf(res)
      return { status: 'down', reason: error?.detail ?? `The health check failed with status ${String(res.status)}` }
    }
    const body = (await res.json()) as EaHealth | EaNotRunning
    return 'running' in body ? { status: 'down', reason: body.reason } : { status: 'up', health: body }
  } catch (e) {
    return { status: 'down', reason: e instanceof Error ? e.message : String(e) }
  }
}

export type SetupNeed = { kind: 'down'; reason: string } | { kind: 'keys'; missing: readonly string[] }

/** What stands between the user and a call: a bot that is not running, or keys it lacks. */
export function setupNeed(state: HealthState): SetupNeed | null {
  if (state.status === 'down') {
    return { kind: 'down', reason: state.reason }
  }
  if (state.status === 'up' && !state.health.configured) {
    return { kind: 'keys', missing: state.health.missing }
  }
  return null
}

/** What stands between the user and the typed chat, which needs only the OpenAI key. */
export function chatNeed(state: HealthState): SetupNeed | null {
  if (state.status === 'down') {
    return { kind: 'down', reason: state.reason }
  }
  if (state.status !== 'up') {
    return null
  }
  const { chat_missing: chatMissing, missing } = state.health
  const needs = chatMissing ?? missing.filter((name) => name === 'OPENAI_API_KEY')
  return needs.length > 0 ? { kind: 'keys', missing: needs } : null
}

/** The bot's health, polled while the app shows; `refresh` checks again right away. */
export function useEaHealth(): { state: HealthState; refresh: () => void } {
  const [state, setState] = useState<HealthState>({ status: 'loading' })
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let live = true
    const check = () => {
      void readHealth().then((next) => {
        if (live) {
          setState(next)
        }
      })
    }
    const stop = startPolling(check, POLL_MS, { leading: true })
    return () => {
      live = false
      stop()
    }
  }, [tick])

  const refresh = useCallback(() => {
    setTick((n) => n + 1)
  }, [])

  return { state, refresh }
}
