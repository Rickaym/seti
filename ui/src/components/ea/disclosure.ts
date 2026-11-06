/** Why the EA details show: the pointer rests on the item, keyboard focus is in it, or a click. */
export interface Disclosure {
  hovered: boolean
  focused: boolean
  pinned: boolean
}

export type DisclosureEvent =
  | { type: 'hover'; inside: boolean }
  | { type: 'focus'; inside: boolean }
  | { type: 'toggle' }
  | { type: 'pin' }
  | { type: 'dismiss' }

export const closedDisclosure: Disclosure = { hovered: false, focused: false, pinned: false }

export const isOpen = ({ hovered, focused, pinned }: Disclosure) => hovered || focused || pinned

/** A click closes whatever holds the details open, so a tap works like hovering does on touch. */
export function disclosureReducer(state: Disclosure, event: DisclosureEvent): Disclosure {
  switch (event.type) {
    case 'hover':
      return state.hovered === event.inside ? state : { ...state, hovered: event.inside }
    case 'focus':
      return state.focused === event.inside ? state : { ...state, focused: event.inside }
    case 'toggle':
      return isOpen(state) ? closedDisclosure : { ...state, pinned: true }
    case 'pin':
      return state.pinned ? state : { ...state, pinned: true }
    case 'dismiss':
      return isOpen(state) ? closedDisclosure : state
  }
}
