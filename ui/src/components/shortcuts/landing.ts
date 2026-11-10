import { useEffect, type RefObject } from 'react'
import { isTyping } from '@/components/shortcuts/chords'

/** Where a keyboard navigation lands: the page in `main`, or the group chat panel. */
export type LandingScope = 'page' | 'team'

/** A navigation this soon after a key press counts as made with the keyboard. */
const KEY_RECENT_MS = 1500
/** How long a landing waits for its destination to render. */
const WAIT_MS = 5000
const PRIMARY_INPUT = '[data-primary-input="true"]'
const HEADING = 'h1, h2'
const OPEN_DIALOG = '[aria-modal="true"], [role="dialog"][data-state="open"]'
const LANDED = 'data-landed'

interface Intent {
  at: number
  /** Where focus was when the navigation started; focus still there is not the user's doing. */
  from: Element | null
}

let lastKey = Number.NEGATIVE_INFINITY
const intents = new Map<LandingScope, Intent>()
let landingArea: ((root: HTMLElement) => HTMLElement | null) | null = null

/**
 * Lets a view that splits the page, such as a layout of agents, name the part a landing goes to.
 * `resolve` returns null while that part has not rendered yet, and the landing waits for it.
 */
export function setLandingArea(resolve: ((root: HTMLElement) => HTMLElement | null) | null): void {
  landingArea = resolve
}

/** Asks the next render of `scope` to take focus, when a key just caused it. */
export function armLanding(scope: LandingScope): void {
  const now = performance.now()
  if (now - lastKey < KEY_RECENT_MS) {
    intents.set(scope, { at: now, from: document.activeElement })
  }
}

/** Keeps focus where a key just put it, as Vim mode does when it moves between panels. */
export function skipLanding(): void {
  lastKey = Number.NEGATIVE_INFINITY
  intents.clear()
}

/** Tells navigation by keyboard from navigation by pointer. */
export function startLanding(): () => void {
  const onKey = () => {
    lastKey = performance.now()
  }
  const onPointer = () => {
    lastKey = Number.NEGATIVE_INFINITY
    intents.clear()
  }
  window.addEventListener('keydown', onKey, { capture: true })
  window.addEventListener('pointerdown', onPointer, { capture: true })
  return () => {
    window.removeEventListener('keydown', onKey, { capture: true })
    window.removeEventListener('pointerdown', onPointer, { capture: true })
  }
}

const shown = (element: Element) => element.checkVisibility()

function primaryInput(root: HTMLElement): HTMLTextAreaElement | HTMLInputElement | null {
  const input = [...root.querySelectorAll(PRIMARY_INPUT)].find(shown)
  return input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement ? input : null
}

const firstHeading = (scope: ParentNode) => [...scope.querySelectorAll<HTMLElement>(HEADING)].find(shown)

/** The open detail's heading before the list's, so a split page lands in what was opened. */
function heading(root: HTMLElement): HTMLElement | null {
  const detail = [...root.querySelectorAll('[data-slot="detail-pane"]')].find(shown)
  return (detail === undefined ? undefined : firstHeading(detail)) ?? firstHeading(root) ?? null
}

/** Focuses a heading or region for screen readers without the ring a focused control shows. */
function focusQuietly(element: HTMLElement): void {
  if (element.hasAttribute(LANDED)) {
    element.focus({ preventScroll: true })
    return
  }
  const added = !element.hasAttribute('tabindex')
  if (added) {
    element.setAttribute('tabindex', '-1')
  }
  element.setAttribute(LANDED, '')
  element.addEventListener(
    'blur',
    () => {
      element.removeAttribute(LANDED)
      if (added) {
        element.removeAttribute('tabindex')
      }
    },
    { once: true },
  )
  element.focus({ preventScroll: true })
}

function focusInput(input: HTMLTextAreaElement | HTMLInputElement): void {
  input.focus({ preventScroll: true })
  const end = input.value.length
  input.setSelectionRange(end, end)
  input.scrollTo({ top: input.scrollHeight })
}

const dialogOver = (root: HTMLElement) =>
  [...document.querySelectorAll(OPEN_DIALOG)].some((dialog) => shown(dialog) && !dialog.contains(root))

/**
 * Focuses the primary input in `root` once it renders, else its heading, else `root`. Phones get
 * no input, since focusing one opens the on-screen keyboard. Returns the teardown.
 */
function land(root: HTMLElement, scope: LandingScope, intent: Intent): () => void {
  const left = WAIT_MS - (performance.now() - intent.at)
  if (left <= 0) {
    intents.delete(scope)
    return () => undefined
  }
  const touch = window.matchMedia('(pointer: coarse)').matches
  const observer = new MutationObserver(() => {
    attempt()
  })
  let landed: HTMLElement | null = null

  const stop = () => {
    observer.disconnect()
    window.clearTimeout(timer)
    window.removeEventListener('keydown', finish, { capture: true })
    window.removeEventListener('pointerdown', finish, { capture: true })
  }
  function finish() {
    if (intents.get(scope) === intent) {
      intents.delete(scope)
    }
    stop()
  }
  const movedOn = (): boolean => {
    const active = document.activeElement
    if (landed !== null) {
      return active !== landed
    }
    return active !== intent.from && isTyping(active)
  }
  function attempt() {
    if (dialogOver(root) || movedOn()) {
      finish()
      return
    }
    const area = scope === 'page' && landingArea !== null ? landingArea(root) : root
    if (area === null) {
      return
    }
    const input = touch ? null : primaryInput(area)
    if (input !== null && !input.disabled) {
      focusInput(input)
      finish()
      return
    }
    const target = heading(area)
    if (target !== null && target !== landed) {
      landed = target
      focusQuietly(target)
    }
  }

  const timer = window.setTimeout(() => {
    if (landed === null && !dialogOver(root) && !movedOn()) {
      focusQuietly(root)
    }
    finish()
  }, left)
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] })
  window.addEventListener('keydown', finish, { capture: true })
  window.addEventListener('pointerdown', finish, { capture: true })
  attempt()
  return stop
}

/** Lands focus in `root` after a keyboard navigation into `scope`, rerun when `trigger` changes. */
export function useFocusLanding(root: RefObject<HTMLElement | null>, scope: LandingScope, trigger?: unknown): void {
  useEffect(() => {
    const element = root.current
    const intent = intents.get(scope)
    if (element === null || intent === undefined) {
      return undefined
    }
    return land(element, scope, intent)
  }, [root, scope, trigger])
}
