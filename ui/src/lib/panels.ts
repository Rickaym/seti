import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

/** Marks an element as a panel that keyboard focus moves between, as Vim mode does. */
export const PANEL = { 'data-panel': '' } as const

/** Marks a panel whose keys all belong to what it holds, such as a terminal. */
export const PANEL_PASSTHROUGH = { 'data-panel-passthrough': '' } as const

/** The attribute on the panel keyboard focus is in, while a mod such as Vim mode marks it. */
const PANEL_ACTIVE = 'data-panel-active'

/** Marks the panel a layout of several holds as focused, where keys go while none has focus. */
export const panelFocused = (focused: boolean) => ({ 'data-panel-focused': focused }) as const

const PANEL_SELECTOR = '[data-panel]'
const FOCUSED = '[data-panel-focused="true"]'
const SCROLL = '[data-panel-scroll]'
const PASSTHROUGH = '.xterm, [data-panel-passthrough], iframe, video, audio, embed, object'
const OVERLAY = [
  '[aria-modal="true"]',
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[data-radix-popper-content-wrapper]:not(:has([data-slot="tooltip-content"]))',
].join(', ')
const PRIMARY_INPUT = '[data-primary-input="true"]'

/** What a panel offers beyond scrolling, such as opening its Files. */
interface PanelActions {
  toggleFiles?: () => void
}

/** How a scroll area returns to the newest content, when the end of the DOM is not the newest. */
const bottoms = new WeakMap<Element, () => void>()
const actions = new WeakMap<Element, PanelActions>()

/** Names `ref` the panel's scroll area, with how it returns to the newest content. */
export function usePanelScroll(ref: RefObject<HTMLElement | null>, toBottom: () => void): void {
  const latest = useRef(toBottom)
  useLayoutEffect(() => {
    latest.current = toBottom
  })
  useEffect(() => {
    const element = ref.current
    if (element === null) {
      return undefined
    }
    element.setAttribute('data-panel-scroll', '')
    bottoms.set(element, () => {
      latest.current()
    })
    return () => {
      element.removeAttribute('data-panel-scroll')
      bottoms.delete(element)
    }
  }, [ref])
}

/** Offers actions of the panel around `ref` to keyboard input hooks, such as Vim keys. */
export function usePanelActions(ref: RefObject<HTMLElement | null>, offered: Required<PanelActions>): void {
  const latest = useRef(offered)
  useLayoutEffect(() => {
    latest.current = offered
  })
  useEffect(() => {
    const element = ref.current
    if (element === null) {
      return undefined
    }
    actions.set(element, {
      toggleFiles: () => {
        latest.current.toggleFiles()
      },
    })
    element.setAttribute('data-panel-actions', '')
    return () => {
      actions.delete(element)
      element.removeAttribute('data-panel-actions')
    }
  }, [ref])
}

const shown = (element: Element) => element.checkVisibility()

/** The panel's own actions, from the element that offered them inside it. */
export function panelActions(panel: HTMLElement): PanelActions {
  for (const holder of [panel, ...panel.querySelectorAll('[data-panel-actions]')]) {
    const offered = actions.get(holder)
    if (offered !== undefined) {
      return offered
    }
  }
  return {}
}

/** Focus is where every key belongs to someone else: a terminal, a frame or a media player. */
export const isPassthrough = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(PASSTHROUGH) !== null

/** A dialog, popover or menu that owns the keys is open. */
export const overlayOpen = (): boolean => [...document.querySelectorAll(OVERLAY)].some(shown)

/** The panel holding `node`, the innermost when panels nest. */
export const panelOf = (node: Node | null): HTMLElement | null => {
  const element = node instanceof Element ? node : (node?.parentElement ?? null)
  return element?.closest<HTMLElement>(PANEL_SELECTOR) ?? null
}

/** Panels on screen that hold no other panel, in reading order: top to bottom, left to right. */
export function visiblePanels(): HTMLElement[] {
  const all = [...document.querySelectorAll<HTMLElement>(PANEL_SELECTOR)].filter(shown)
  const leaves = all.filter((panel) => !all.some((other) => other !== panel && panel.contains(other)))
  const boxes = new Map(leaves.map((panel) => [panel, panel.getBoundingClientRect()]))
  const box = (panel: HTMLElement) => boxes.get(panel) ?? panel.getBoundingClientRect()
  return leaves.sort((a, b) => {
    const [ra, rb] = [box(a), box(b)]
    return Math.abs(ra.top - rb.top) > 4 ? ra.top - rb.top : ra.left - rb.left
  })
}

/** The panel above or below `from` that overlaps it most across, nearest first. */
export function panelBeside(from: HTMLElement, panels: readonly HTMLElement[], direction: 1 | -1): HTMLElement | null {
  const origin = from.getBoundingClientRect()
  let best: { panel: HTMLElement; gap: number; overlap: number } | null = null
  for (const panel of panels) {
    const rect = panel.getBoundingClientRect()
    const gap = direction === 1 ? rect.top - origin.bottom : origin.top - rect.bottom
    const overlap = Math.min(rect.right, origin.right) - Math.max(rect.left, origin.left)
    if (panel === from || gap < -4 || overlap <= 0) {
      continue
    }
    if (best === null || gap < best.gap - 4 || (Math.abs(gap - best.gap) <= 4 && overlap > best.overlap)) {
      best = { panel, gap, overlap }
    }
  }
  return best?.panel ?? null
}

const scrollable = (element: HTMLElement) => {
  if (element.scrollHeight - element.clientHeight <= 1) {
    return false
  }
  const { overflowY } = getComputedStyle(element)
  return overflowY === 'auto' || overflowY === 'scroll'
}

/** The panel's scroll area: the one it names, else its largest area that scrolls. */
export function scrollerOf(panel: HTMLElement): HTMLElement | null {
  const named = [...panel.querySelectorAll<HTMLElement>(SCROLL)].find(shown)
  if (named !== undefined) {
    return named
  }
  let best: HTMLElement | null = scrollable(panel) ? panel : null
  for (const element of panel.querySelectorAll<HTMLElement>('div, section, main, ul, ol, pre, article')) {
    if (scrollable(element) && shown(element) && element.clientHeight > (best?.clientHeight ?? 0)) {
      best = element
    }
  }
  return best
}

/** Moves the scroll area to its newest content, which may need more than its end. */
export function scrollToBottom(scroller: HTMLElement): void {
  const toBottom = bottoms.get(scroller)
  if (toBottom === undefined) {
    scroller.scrollTo({ top: scroller.scrollHeight })
  } else {
    toBottom()
  }
}

/** The panel's reply box, else its first field. */
export function composerOf(panel: HTMLElement): HTMLTextAreaElement | HTMLInputElement | null {
  const fields = [
    ...panel.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(PRIMARY_INPUT),
    ...panel.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(
      'textarea, input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="hidden"])',
    ),
  ]
  return fields.find((field) => shown(field) && !field.disabled && !isPassthrough(field)) ?? null
}

/** The panel's own search field, for panels without a chat find, such as Files. */
export const searchFieldOf = (panel: HTMLElement): HTMLInputElement | null =>
  [...panel.querySelectorAll<HTMLInputElement>('[role="search"] input')].find(shown) ?? null

/** The panel the page itself has selected: the one a layout of several holds as focused. */
export const selectedPanel = (): HTMLElement | null => document.querySelector<HTMLElement>(FOCUSED)

/** Marks the panel keyboard focus is in, and clears the mark from every other; null clears all. */
export function markActivePanel(panel: HTMLElement | null): void {
  for (const marked of document.querySelectorAll<HTMLElement>(`[${PANEL_ACTIVE}]`)) {
    if (marked !== panel) {
      marked.removeAttribute(PANEL_ACTIVE)
    }
  }
  panel?.setAttribute(PANEL_ACTIVE, '')
}
