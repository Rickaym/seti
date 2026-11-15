import type { MouseEvent } from 'react'

/** A mousedown handler for a button beside a text box: tapping it leaves the box focused. */
export const keepFocus = (e: MouseEvent) => {
  e.preventDefault()
}
