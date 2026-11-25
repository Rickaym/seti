import { RUNTIME_NAMES, type StoredRuntime } from '@seti/shared'

/** A runtime's name as a one-word tag says it: Claude, Codex. */
const short = (runtime: StoredRuntime) => RUNTIME_NAMES[runtime].split(' ')[0] ?? RUNTIME_NAMES[runtime]

/**
 * What to say of something only some runtimes can use, against the runtimes that are on: null
 * when every one of them can, so nothing mentions a runtime that is off.
 */
export function runtimeTag(
  usable: readonly StoredRuntime[],
  on: readonly StoredRuntime[],
): { label: string; missing: string } | null {
  const missing = on.filter((runtime) => !usable.includes(runtime))
  if (missing.length === 0) {
    return null
  }
  const left = on.filter((runtime) => usable.includes(runtime))
  const names = missing.map((runtime) => RUNTIME_NAMES[runtime]).join(' and ')
  const [only] = left
  return { label: left.length === 1 && only !== undefined ? `${short(only)} only` : `Not on ${names}`, missing: names }
}
