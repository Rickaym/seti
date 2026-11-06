import { isRecord } from './lenient.js'

/** A JSON object as a sender's payload holds it. */
export type JsonRecord = Record<string, unknown>

/** The object at `key`, or an empty one when there is none. */
export const recordAt = (value: unknown, key: string): JsonRecord => {
  const inner = isRecord(value) ? value[key] : undefined
  return isRecord(inner) ? inner : {}
}

/** A string or number at `key`, as trimmed text; empty when absent. */
export function textAt(value: unknown, key: string): string {
  const inner = isRecord(value) ? value[key] : undefined
  if (typeof inner === 'string') {
    return inner.trim()
  }
  return typeof inner === 'number' && Number.isFinite(inner) ? String(inner) : ''
}

/** An ISO time or epoch seconds or milliseconds, as ISO; null when it is neither. */
export function timeOf(value: unknown): string | null {
  const epochMs = (n: number) => (n < 1e12 ? n * 1000 : n)
  let parsed = Number.NaN
  if (typeof value === 'number') {
    parsed = epochMs(value)
  } else if (typeof value === 'string' && value.trim() !== '') {
    parsed = /^\d+(\.\d+)?$/.test(value.trim()) ? epochMs(Number(value)) : Date.parse(value)
  }
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

export const firstText = (...texts: string[]) => texts.find((text) => text !== '') ?? ''

export const orNull = (text: string) => (text === '' ? null : text)
