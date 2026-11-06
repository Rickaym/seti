import { MOD_CHORD, Registry, type Disposer } from '@seti/shared'
import { useSyncExternalStore } from 'react'
import { CHORDS, chordLabel, sectionChord, useChords, type Chord } from '@/components/shortcuts/chords'

const KEYS: Readonly<Record<string, { code: string; key: string }>> = {
  Left: { code: 'ArrowLeft', key: 'Left' },
  Right: { code: 'ArrowRight', key: 'Right' },
  Up: { code: 'ArrowUp', key: 'Up' },
  Down: { code: 'ArrowDown', key: 'Down' },
  '[': { code: 'BracketLeft', key: '[' },
  ']': { code: 'BracketRight', key: ']' },
}

/** A chord as a manifest writes it, such as `Alt+Shift+G`; Ctrl means Cmd on Apple. */
export function parseModChord(text: string): Chord {
  const match = MOD_CHORD.exec(text)
  const name = match?.[3]
  if (match === null || name === undefined) {
    throw new Error(`${text} is not a chord`)
  }
  const known = KEYS[name]
  const key = known ?? { code: /\d/u.test(name) ? `Digit${name}` : `Key${name}`, key: name }
  const chord: Chord = { ...key, modifier: match[1] === 'Alt' ? 'alt' : 'primary' }
  return match[2] === undefined ? chord : { ...chord, shift: true }
}

/** A chord a running mod binds, and what it runs. */
export interface ModChordEntry {
  /** `<mod>.<command>` for a command's chord, `<mod>.<view>.<n>` for one a view binds. */
  key: string
  chord: Chord
  /** Whose it is, for the line that says a chord is taken. */
  owner: string
  run: () => void
}

export const modChords = new Registry<ModChordEntry>('chord', (entry) => entry.key)

const SECTION_DIGITS = 9

const same = (a: Chord, b: Chord) =>
  a.code === b.code && a.modifier === b.modifier && (a.shift === true) === (b.shift === true)

/** Seti's own chords outside CHORDS: the palette, group chat, EA call and find. */
const OTHER_SETI_CHORDS: readonly Chord[] = [
  { code: 'KeyK', key: 'K', modifier: 'primary' },
  { code: 'KeyL', key: 'L', modifier: 'primary', shift: true },
  { code: 'KeyE', key: 'E', modifier: 'primary', shift: true },
  { code: 'KeyF', key: 'F', modifier: 'primary' },
  { code: 'KeyF', key: 'F', modifier: 'primary', shift: true },
]

/** Seti's own chords, which no mod may take. */
const setiChords = (): Chord[] => [
  ...Object.values(CHORDS),
  ...OTHER_SETI_CHORDS,
  ...Array.from({ length: SECTION_DIGITS }, (_, i) => sectionChord(i + 1)),
]

/** Who already binds `chord`: Seti, or another mod's entry under a different key. */
function takenBy(chord: Chord, key: string): string | null {
  if (setiChords().some((taken) => same(taken, chord))) {
    return 'Seti'
  }
  return modChords.list().find((entry) => entry.key !== key && same(entry.chord, chord))?.owner ?? null
}

/** Binds a mod's chord, refusing one Seti or another mod already binds. */
export function registerModChord(entry: ModChordEntry): Disposer {
  const owner = takenBy(entry.chord, entry.key)
  if (owner !== null) {
    throw new Error(`${chordLabel(entry.chord)} is taken by ${owner}`)
  }
  return modChords.register(entry)
}

/** Runs each running mod's chords while the app runs. */
export function useModChordKeys(): void {
  useChords(useSyncExternalStore(modChords.subscribe, modChords.list))
}
