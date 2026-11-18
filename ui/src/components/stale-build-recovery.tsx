import { RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import { isUnreachable, pingApi } from '@/api'
import { hasUnsavedChanges } from '@/lib/leave-guard'
import { planRecovery, type StaleRecovery } from '@/lib/stale-build'

const PING_TIMEOUT_MS = 5000

export const reloadPage = (): void => {
  window.location.reload()
}

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/** The entry script's address carries the build's hash, so it names the build this page runs. */
const runningBuild = () => document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src ?? ''

async function serverAnswers(): Promise<boolean> {
  try {
    await pingApi(AbortSignal.timeout(PING_TIMEOUT_MS))
    return true
  } catch (e) {
    return !isUnreachable(e)
  }
}

function offerNewVersion(): void {
  toast('New version', {
    id: 'seti-new-version',
    duration: Infinity,
    icon: <RotateCw className="size-4" aria-hidden />,
    description: 'Seti was updated. Save your changes, then reload to get it.',
    action: { label: 'Reload', onClick: reloadPage },
  })
}

let reloading = false
let planning: Promise<StaleRecovery> | null = null

async function recover(): Promise<StaleRecovery> {
  const recovery = await planRecovery({
    storage: sessionStore(),
    build: runningBuild(),
    now: Date.now(),
    unsaved: hasUnsavedChanges(),
    reachable: serverAnswers,
  })
  if (recovery === 'reload') {
    reloading = true
    reloadPage()
  } else if (recovery === 'notice') {
    offerNewVersion()
  }
  return recovery
}

/** Reloads the page once when a build file did not load, or says what the user can do instead. */
export async function recoverFromStaleBuild(): Promise<StaleRecovery> {
  if (reloading) {
    return 'reload'
  }
  planning ??= recover().finally(() => {
    planning = null
  })
  return planning
}

/** Vite reports each lazy file that fails to load, also where no error boundary sees it. */
export function watchStaleBuild(): void {
  window.addEventListener('vite:preloadError', () => {
    void recoverFromStaleBuild()
  })
}
