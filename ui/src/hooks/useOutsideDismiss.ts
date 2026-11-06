import { useEffect, useLayoutEffect, useRef } from 'react'

/** Clicks here belong to the drawer's own flow: its dialogs, menus, toasts, or its pressed toggle. */
const KEEP = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[data-radix-popper-content-wrapper]',
  '[data-sonner-toaster]',
  '[aria-pressed="true"]',
].join(', ')

const UNARMED = Symbol('unarmed')

interface Latest {
  inside: () => Element | null
  state: unknown
  onDismiss: () => void
}

/** While `open`, a click from outside `inside` dismisses, unless it changed `state` itself. */
export function useOutsideDismiss(open: boolean, latest: Latest): void {
  const current = useRef(latest)
  useLayoutEffect(() => {
    current.current = latest
  })
  useEffect(() => {
    if (!open) {
      return undefined
    }
    let armed: unknown = UNARMED
    let timer: ReturnType<typeof setTimeout> | undefined
    const onDown = (event: PointerEvent) => {
      const { target } = event
      const box = current.current.inside()
      const outside =
        target instanceof Element && box !== null && !box.contains(target) && target.closest(KEEP) === null
      armed = outside ? current.current.state : UNARMED
    }
    const onClick = () => {
      if (armed === UNARMED) {
        return
      }
      const before = armed
      armed = UNARMED
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (current.current.state === before) {
          current.current.onDismiss()
        }
      }, 0)
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('click', onClick, true)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('click', onClick, true)
    }
  }, [open])
}
