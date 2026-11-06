import type { ModViewTheme } from '@seti/mod-api'
import { useMemo, useSyncExternalStore } from 'react'

const THEME_ATTRIBUTES = ['class', 'data-theme', 'data-flavour', 'data-accent']

/** Calls back whenever the theme on <html> changes. */
function subscribeTheme(notify: () => void): () => void {
  const observer = new MutationObserver(notify)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: THEME_ATTRIBUTES })
  return () => {
    observer.disconnect()
  }
}

/** A key that changes whenever the theme, its flavour or accent, or light and dark changes. */
const themeStamp = () => THEME_ATTRIBUTES.map((name) => document.documentElement.getAttribute(name) ?? '').join('|')

/** The theme views draw in, as mods' viewers get it. */
export function useViewTheme(): ModViewTheme {
  const key = useSyncExternalStore(subscribeTheme, themeStamp)
  return useMemo(() => ({ key, dark: document.documentElement.classList.contains('dark') }), [key])
}
