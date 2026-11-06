import { useCallback, useSyncExternalStore } from 'react'

function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia(query)
      media.addEventListener('change', onChange)
      return () => {
        media.removeEventListener('change', onChange)
      }
    },
    [query],
  )
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches)
}

/** True on touch screens, where hover and keyboard shortcut hints do not apply. */
export const useCoarsePointer = () => useMediaQuery('(pointer: coarse)')

export const NARROW_QUERY = '(width < 48rem), (pointer: coarse) and (height < 30rem)'

/** True where the `max-md` variant applies: the layout shows one pane at a time. */
export const useNarrow = () => useMediaQuery(NARROW_QUERY)

/** The same as `useNarrow`, read once, for code that runs outside a component. */
export const isNarrow = () => window.matchMedia(NARROW_QUERY).matches

/** Follows the device's light or dark setting as it changes. */
export const usePrefersDark = () => useMediaQuery('(prefers-color-scheme: dark)')

/** True when the device asks for less motion, so animations hold still. */
export const usePrefersReducedMotion = () => useMediaQuery('(prefers-reduced-motion: reduce)')

/** A media query as a signal, for code outside components that follows it. */
export const mediaSignal = (query: string) => ({
  get: () => window.matchMedia(query).matches,
  subscribe: (listener: () => void) => {
    const media = window.matchMedia(query)
    media.addEventListener('change', listener)
    return () => {
      media.removeEventListener('change', listener)
    }
  },
})
