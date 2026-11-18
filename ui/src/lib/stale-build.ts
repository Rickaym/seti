const RELOADED_KEY = 'seti.stale-build.reloaded'

/** A second failure this soon after an automatic reload means the reload did not help. */
export const RELOAD_WINDOW_MS = 60_000

/** What Chrome, Firefox, Safari and Vite's preloader say when a build file cannot be loaded. */
const LOAD_FAILURE =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i

/** Whether a crash is a build file that did not load, as after a deploy replaced the build. */
export const isStaleBuildError = (error: unknown) => error instanceof Error && LOAD_FAILURE.test(error.message)

type ReloadStorage = Pick<Storage, 'getItem' | 'setItem'>

interface Reloaded {
  build: string
  at: number
}

function readReloaded(storage: ReloadStorage): Reloaded | null {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(RELOADED_KEY) ?? 'null')
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }
    const { build, at } = parsed as Record<string, unknown>
    return typeof build === 'string' && typeof at === 'number' ? { build, at } : null
  } catch {
    return null
  }
}

/**
 * Takes the one automatic reload a build gets, and records it. Refuses when this tab already
 * reloaded from the same build or within the window, and when the record cannot be kept.
 */
export function claimReload(storage: ReloadStorage | null, build: string, now: number): boolean {
  if (storage === null) {
    return false
  }
  const last = readReloaded(storage)
  if (last !== null && (last.build === build || Math.abs(now - last.at) < RELOAD_WINDOW_MS)) {
    return false
  }
  try {
    storage.setItem(RELOADED_KEY, JSON.stringify({ build, at: now }))
    return true
  } catch {
    return false
  }
}

/** reload: load the new build now. notice: offer it over unsaved work. manual: the user reloads. */
export type StaleRecovery = 'reload' | 'notice' | 'manual'

interface RecoveryInput {
  storage: ReloadStorage | null
  /** Names the build this page runs, such as the address of its entry script. */
  build: string
  now: number
  /** A form holds changes a reload would discard. */
  unsaved: boolean
  /** Whether the server answers, so a reload lands on Seti and not on a browser error page. */
  reachable: () => Promise<boolean>
}

export async function planRecovery(input: RecoveryInput): Promise<StaleRecovery> {
  if (!(await input.reachable())) {
    return 'manual'
  }
  if (input.unsaved) {
    return 'notice'
  }
  return claimReload(input.storage, input.build, input.now) ? 'reload' : 'manual'
}
