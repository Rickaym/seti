import { useEffect, useSyncExternalStore } from 'react'

/** Input types that bring up no text keyboard. */
const NO_KEYBOARD = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
])

/**
 * A field taking text on the page itself, xterm's hidden textarea included. Fields in dialogs,
 * sheets and popovers sit over the page and keep its chrome, unless the dialog opts in with
 * `data-typing-room`, as the group chat does since it fills a phone screen.
 */
function typingSurface(el: Element | null): boolean {
  const field =
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && !NO_KEYBOARD.has(el.type)) ||
    (el instanceof HTMLElement && el.isContentEditable)
  if (!field) {
    return false
  }
  const dialog = el.closest('[role="dialog"], [role="alertdialog"]')
  return dialog === null || dialog.hasAttribute('data-typing-room')
}

/** A shrink smaller than this is the browser's own bars coming and going, not a keyboard. */
const KEYBOARD_MIN_PX = 80
const KEYBOARD_SHARE = 0.15
/** The keyboard-free sizes below which the layout is the one-pane phone one (48rem, 30rem). */
const PHONE_WIDTH_PX = 768
const PHONE_HEIGHT_PX = 480
/** Focus hopping from a field to its own buttons must not flash the chrome back. */
const RELEASE_MS = 250

const listeners = new Set<() => void>()
let typing = false

function setTyping(next: boolean): void {
  if (next === typing) {
    return
  }
  typing = next
  document.documentElement.toggleAttribute('data-typing', next)
  for (const listener of listeners) {
    listener()
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** True while a phone's keyboard is up for a text field on the page. */
export const useTyping = () => useSyncExternalStore(subscribe, () => typing)

/**
 * Turns typing mode on while a phone's on-screen keyboard is up for a field on the page, so the
 * shell can hand that surface the room. Install once, in the app shell.
 */
export function useTypingMode(): void {
  useEffect(() => {
    const viewport = window.visualViewport
    if (viewport === null) {
      return undefined
    }
    const coarse = window.matchMedia('(pointer: coarse)')
    const tallest = new Map<number, number>()
    let release: ReturnType<typeof setTimeout> | undefined

    const wanted = () => {
      const width = Math.round(viewport.width * viewport.scale)
      const height = viewport.height * viewport.scale
      const full = Math.max(tallest.get(width) ?? 0, height)
      tallest.set(width, full)
      const keyboard = full - height > Math.max(KEYBOARD_MIN_PX, full * KEYBOARD_SHARE)
      const phone = coarse.matches && (width < PHONE_WIDTH_PX || full < PHONE_HEIGHT_PX)
      const focused = typingSurface(document.activeElement)
      return phone && keyboard && focused
    }
    const update = () => {
      clearTimeout(release)
      release = undefined
      if (wanted()) {
        setTyping(true)
      } else if (typing) {
        release = setTimeout(() => {
          release = undefined
          setTyping(wanted())
        }, RELEASE_MS)
      }
    }

    update()
    viewport.addEventListener('resize', update)
    document.addEventListener('focusin', update)
    document.addEventListener('focusout', update)
    coarse.addEventListener('change', update)
    return () => {
      clearTimeout(release)
      viewport.removeEventListener('resize', update)
      document.removeEventListener('focusin', update)
      document.removeEventListener('focusout', update)
      coarse.removeEventListener('change', update)
      setTyping(false)
    }
  }, [])
}
