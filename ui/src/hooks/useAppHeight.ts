import { useEffect } from 'react'

/**
 * Sizes the app to the visible viewport on touch screens, so the on-screen keyboard shrinks it
 * where the browser ignores `interactive-widget=resizes-content` (iOS Safari).
 */
export function useAppHeight() {
  useEffect(() => {
    const viewport = window.visualViewport
    if (viewport === null || !window.matchMedia('(pointer: coarse)').matches) {
      return undefined
    }
    const root = document.documentElement
    const update = () => {
      root.style.setProperty('--app-height', `${String(Math.round(viewport.height * viewport.scale))}px`)
    }
    update()
    viewport.addEventListener('resize', update)
    return () => {
      viewport.removeEventListener('resize', update)
      root.style.removeProperty('--app-height')
    }
  }, [])
}
