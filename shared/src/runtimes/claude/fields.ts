import { isRecord } from '../../lenient.js'

const at = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined)

/** The string at `key`, unchanged, or undefined. */
export function str(value: unknown, key: string): string | undefined {
  const found = at(value, key)
  return typeof found === 'string' ? found : undefined
}

/** The string at `key` when it holds more than white space, or undefined. */
export function filled(value: unknown, key: string): string | undefined {
  const found = str(value, key)
  return found === undefined || found.trim() === '' ? undefined : found
}

/** The finite number at `key`, or undefined. */
export function num(value: unknown, key: string): number | undefined {
  const found = at(value, key)
  return typeof found === 'number' && Number.isFinite(found) ? found : undefined
}

/** The boolean at `key`, or undefined. */
export function bool(value: unknown, key: string): boolean | undefined {
  const found = at(value, key)
  return typeof found === 'boolean' ? found : undefined
}

/** The array at `key`, or an empty one. */
export function list(value: unknown, key: string): unknown[] {
  const found = at(value, key)
  return Array.isArray(found) ? found : []
}

/** The object at `key`, or undefined. */
export function obj(value: unknown, key: string): Record<string, unknown> | undefined {
  const found = at(value, key)
  return isRecord(found) ? found : undefined
}

/** `{ [key]: value }` when the value is present, else nothing: spreads an optional field. */
export const some = <K extends string, V>(key: K, value: V | null | undefined): Partial<Record<K, V>> =>
  value === undefined || value === null ? {} : ({ [key]: value } as Partial<Record<K, V>>)
