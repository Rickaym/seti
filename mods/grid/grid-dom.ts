import { useLayoutEffect, useState, type RefObject } from 'react'

/** The protocol the page talks to Seti over; a service worker hides it on the navigation entry. */
export function connectionProtocol(): string {
  const entries = [
    ...performance.getEntriesByType('navigation'),
    ...performance.getEntriesByType('resource'),
  ] as PerformanceResourceTiming[]
  return entries.find((entry) => entry.nextHopProtocol !== '')?.nextHopProtocol ?? ''
}

export const ANNOUNCER_ID = 'agent-grid-announcer'

/** Tells screen readers what a grid action did, through the grid's status region. */
export function announce(text: string): void {
  const region = document.getElementById(ANNOUNCER_ID)
  if (region === null) {
    return
  }
  region.textContent = ''
  requestAnimationFrame(() => {
    region.textContent = text
  })
}

export const panelElement = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-grid-panel="${id}"]`)

/** Scrolls the grid to a panel that lies wholly out of view, such as one on the next screen. */
export function revealPanel(id: string): void {
  const root = panelElement(id)
  const area = root?.closest('[data-grid-area]')
  if (root === null || area === null || area === undefined) {
    return
  }
  const panel = root.getBoundingClientRect()
  const view = area.getBoundingClientRect()
  if (panel.bottom <= view.top || panel.top >= view.bottom) {
    root.scrollIntoView({ block: 'nearest' })
  }
}

/** Focuses the panel's reply box, or the panel itself when it has none. */
export function focusInto(id: string): void {
  const root = panelElement(id)
  if (root === null) {
    return
  }
  const inputs = [...root.querySelectorAll<HTMLElement>('[data-primary-input="true"]')]
  const input = inputs.find((element) => element.checkVisibility())
  ;(input ?? root).focus({ preventScroll: true })
}

/** The page shows the Agents section, which an empty address opens too. */
export function onAgentsPage(): boolean {
  const { hash } = window.location
  return hash === '' || hash === '#' || hash === '#agents' || hash.startsWith('#agents/')
}

/** Points the address at the focused panel's agent without adding a history entry. */
export function showInAddress(id: string | null): void {
  const hash = id === null ? '#agents' : `#agents/${id}`
  if (window.location.hash !== hash) {
    window.location.replace(hash)
  }
}

export function useRoom(element: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [room, setRoom] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const target = element.current
    if (target === null) {
      return undefined
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) {
        const { width, height } = entry.contentRect
        setRoom((prev) => (prev.width === width && prev.height === height ? prev : { width, height }))
      }
    })
    observer.observe(target)
    return () => {
      observer.disconnect()
    }
  }, [element])
  return room
}
