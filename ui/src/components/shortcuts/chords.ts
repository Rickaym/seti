import { useEffect, useLayoutEffect, useRef } from 'react'

const APPLE = /Mac|iPhone|iPad/u.test(navigator.userAgent)

/** A physical key held with Alt (Option on Apple) or with the primary modifier, Ctrl or Cmd. */
export interface Chord {
  /** The KeyboardEvent code, so layouts and Option's typed characters do not change it. */
  code: string
  key: string
  modifier: 'alt' | 'primary'
  shift?: boolean
}

const altChord = (code: string, key: string): Chord => ({ code, key, modifier: 'alt' })

/** App actions take Alt; the guide takes Ctrl+/ (Cmd+/ on Apple) like other web apps' key help. */
export const CHORDS = {
  newAgent: altChord('KeyN', 'N'),
  importSessions: altChord('KeyI', 'I'),
  filterAgents: altChord('Slash', '/'),
  switchLogin: altChord('KeyA', 'A'),
  nextUnseen: altChord('KeyU', 'U'),
  ownBack: altChord('BracketLeft', '['),
  ownForward: altChord('BracketRight', ']'),
  guide: { code: 'Slash', key: '/', modifier: 'primary' },
} as const satisfies Record<string, Chord>

/** Alt with a digit opens the sidebar section at that position, 1 to 9. */
export const sectionChord = (position: number): Chord => altChord(`Digit${String(position)}`, String(position))

const LABELS = {
  alt: { apple: 'Opt', other: 'Alt' },
  primary: { apple: 'Cmd', other: 'Ctrl' },
}

const ARIA = {
  alt: { apple: 'Alt', other: 'Alt' },
  primary: { apple: 'Meta', other: 'Control' },
}

const platform = (apple: boolean) => (apple ? 'apple' : 'other')

/** How the chord reads on this device, as in `Alt+N` or `Cmd+/`. */
export const chordLabel = (chord: Chord, apple = APPLE): string =>
  `${LABELS[chord.modifier][platform(apple)]}+${chord.shift === true ? 'Shift+' : ''}${chord.key}`

/** The chord in aria-keyshortcuts syntax. */
export const chordAria = (chord: Chord, apple = APPLE): string =>
  `${ARIA[chord.modifier][platform(apple)]}+${chord.shift === true ? 'Shift+' : ''}${chord.key}`

const TEXT_INPUT = 'input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="reset"])'
const TYPING = [
  TEXT_INPUT,
  'textarea',
  'select',
  ...['textbox', 'searchbox', 'combobox', 'listbox', 'menu', 'menubar', 'tree', 'grid', 'treegrid'].map(
    (role) => `[role="${role}"]`,
  ),
].join(', ')

/** Focus sits where keys type text or drive typeahead. */
export function isTyping(target: EventTarget | null): boolean {
  return (
    target !== null && target instanceof HTMLElement && (target.isContentEditable || target.closest(TYPING) !== null)
  )
}

type Stroke = Pick<
  KeyboardEvent,
  'code' | 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'isComposing' | 'target' | 'getModifierState'
>

const primaryHeld = (stroke: Stroke, apple: boolean) =>
  (apple ? stroke.metaKey && !stroke.ctrlKey : stroke.ctrlKey && !stroke.metaKey) && !stroke.altKey

/** Option types characters on Apple, so there Alt chords skip fields. */
const altHeld = (stroke: Stroke, apple: boolean) =>
  stroke.altKey &&
  !stroke.ctrlKey &&
  !stroke.metaKey &&
  !stroke.getModifierState('AltGraph') &&
  !(apple && isTyping(stroke.target))

/** Whether the stroke is the chord on this device; AltGr and composing text never count. */
export function matchesChord(stroke: Stroke, chord: Chord, apple = APPLE): boolean {
  const shift = chord.shift === true
  if (stroke.isComposing || stroke.key === 'Process' || stroke.shiftKey !== shift || stroke.code !== chord.code) {
    return false
  }
  return chord.modifier === 'primary' ? primaryHeld(stroke, apple) : altHeld(stroke, apple)
}

const MODAL = '[aria-modal="true"], [role="dialog"][data-state="open"]'

const modalOpen = () => [...document.querySelectorAll(MODAL)].some((element) => element.checkVisibility())

/** Runs each binding's action on its chord while mounted; a modal on top keeps the keys. */
export function useChords(bindings: readonly { chord: Chord; run: () => void }[]): void {
  const latest = useRef(bindings)
  useLayoutEffect(() => {
    latest.current = bindings
  })
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) {
        return
      }
      const binding = latest.current.find(({ chord }) => matchesChord(e, chord))
      if (binding === undefined || modalOpen()) {
        return
      }
      e.preventDefault()
      if (!e.repeat) {
        binding.run()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])
}
