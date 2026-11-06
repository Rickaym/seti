import {
  useEffect,
  useReducer,
  useRef,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react'
import { closedDisclosure, disclosureReducer, isOpen } from './disclosure'

const OPEN_DELAY_MS = 250
const CLOSE_DELAY_MS = 200

/**
 * Opens on hover, keyboard focus or a click inside `root`, without ever moving focus itself.
 * `panel` is details rendered outside `root`, such as a sheet; `hover` false leaves only clicks.
 */
export function useDisclosure(
  root: RefObject<HTMLElement | null>,
  { panel, hover: hoverOpens = true }: { panel?: RefObject<HTMLElement | null>; hover?: boolean } = {},
) {
  const [state, send] = useReducer(disclosureReducer, closedDisclosure)
  const timer = useRef(0)
  const open = isOpen(state)

  useEffect(
    () => () => {
      window.clearTimeout(timer.current)
    },
    [],
  )

  useEffect(() => {
    if (!state.pinned) {
      return undefined
    }
    const onPointerDown = (e: globalThis.PointerEvent) => {
      const inside = (area: RefObject<HTMLElement | null> | undefined) =>
        e.target instanceof Node && area?.current?.contains(e.target) === true
      if (e.target instanceof Node && !inside(root) && !inside(panel)) {
        send({ type: 'dismiss' })
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [state.pinned, root, panel])

  const hover = (e: PointerEvent, inside: boolean) => {
    if (e.pointerType === 'touch' || !hoverOpens) {
      return
    }
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(
      () => {
        send({ type: 'hover', inside })
      },
      inside ? OPEN_DELAY_MS : CLOSE_DELAY_MS,
    )
  }

  const handlers = {
    onPointerEnter: (e: PointerEvent) => {
      hover(e, true)
    },
    onPointerLeave: (e: PointerEvent) => {
      hover(e, false)
    },
    onFocus: (e: FocusEvent) => {
      if (e.target.matches(':focus-visible')) {
        send({ type: 'focus', inside: true })
      }
    },
    onBlur: (e: FocusEvent) => {
      const next = e.relatedTarget
      if (!(next instanceof Node && e.currentTarget.contains(next))) {
        send({ type: 'focus', inside: false })
      }
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        e.preventDefault()
        window.clearTimeout(timer.current)
        send({ type: 'dismiss' })
      }
    },
  }

  return {
    open,
    handlers,
    toggle: () => {
      window.clearTimeout(timer.current)
      send({ type: 'toggle' })
    },
    pin: () => {
      send({ type: 'pin' })
    },
    close: () => {
      window.clearTimeout(timer.current)
      send({ type: 'dismiss' })
    },
  }
}
