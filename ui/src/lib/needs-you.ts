import { isNarrow } from '@/hooks/useMedia'
import { navigate, parseHash } from '@/lib/route'

const listeners = new Set<() => void>()
let pending = false

const notify = () => {
  requestAnimationFrame(() => {
    for (const listener of listeners) {
      listener()
    }
  })
}

/**
 * Shows the agent list's Needs you group, unfolded and scrolled into view. A wide layout keeps
 * the open agent beside the list; a phone, which shows one pane at a time, goes to the list.
 */
export function revealNeedsYou(): void {
  pending = true
  const route = parseHash()
  if (route.section === 'agents' && (route.id === null || !isNarrow())) {
    notify()
    return
  }
  window.addEventListener('hashchange', notify, { once: true })
  navigate('agents')
}

/** The query the manifest's Needs you shortcut opens Seti with. */
const SHORTCUT = { key: 'view', value: 'needs-you' }

/** Shows the Needs you group when Seti opens from the app icon's shortcut, then drops the query. */
export function openNeedsYouShortcut(): void {
  const url = new URL(window.location.href)
  if (url.searchParams.get(SHORTCUT.key) !== SHORTCUT.value) {
    return
  }
  url.searchParams.delete(SHORTCUT.key)
  window.history.replaceState(window.history.state, '', url)
  revealNeedsYou()
}

/** Runs `reveal` for a request made before the group mounted, and for each one after. */
export function onRevealNeedsYou(reveal: () => void): () => void {
  const run = () => {
    if (pending) {
      pending = false
      reveal()
    }
  }
  listeners.add(run)
  run()
  return () => {
    listeners.delete(run)
  }
}

const COLLAPSED_KEY = 'seti.agents.needs-you.collapsed'

export function storedCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

export function storeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    // Storage can be blocked; the choice then lasts for this visit only.
  }
}
