import { useLayoutEffect } from 'react'
import { titlebarArea, titlebarVars } from '@/lib/titlebar'

/** Marks <html> with `data-titlebar="overlay"` while an installed app hides the OS title bar. */
export function useWindowControlsOverlay() {
  useLayoutEffect(() => {
    const overlay = navigator.windowControlsOverlay
    if (overlay === undefined) {
      return undefined
    }
    const root = document.documentElement
    const update = () => {
      const area = titlebarArea(overlay)
      if (area === null) {
        root.removeAttribute('data-titlebar')
        return
      }
      for (const [name, value] of Object.entries(titlebarVars(area))) {
        root.style.setProperty(name, value)
      }
      root.setAttribute('data-titlebar', 'overlay')
    }
    update()
    overlay.addEventListener('geometrychange', update)
    return () => {
      overlay.removeEventListener('geometrychange', update)
      root.removeAttribute('data-titlebar')
    }
  }, [])
}
