import type { UiModApi } from '@seti/mod-api'

let current: UiModApi | null = null

/** Keeps the API Seti handed the grid's UI half, for the grid's modules to reach Seti through. */
export function setSeti(api: UiModApi | null): void {
  current = api
}

/** The mod API the running grid got; the grid's code runs only while the mod does. */
export function seti(): UiModApi {
  if (current === null) {
    throw new Error('The grid mod is not running')
  }
  return current
}

/** Joins class names, letting later Tailwind classes win. */
export const cn = (...classes: (string | false | null | undefined)[]): string => seti().kit.cn(...classes)
