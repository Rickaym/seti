import { CHORDS, useChords } from '@/components/shortcuts/chords'
import type { OwnDirection } from '@/lib/own-messages'
import { selectedPanel } from '@/lib/panels'

/** A transcript that steps through the user's own messages. */
interface OwnStepper {
  root: () => HTMLElement | null
  /** Whether it holds own messages to step to, loaded or not. */
  hasOwn: () => boolean
  step: (direction: OwnDirection) => void
}

const steppers = new Set<OwnStepper>()

/** Offers a shown transcript to the step chords; returns the teardown. */
export function registerOwnSteps(stepper: OwnStepper): () => void {
  steppers.add(stepper)
  return () => {
    steppers.delete(stepper)
  }
}

/** The one shown transcript that sits nearest the focused element, if one does. */
function nearFocus(shown: readonly OwnStepper[]): OwnStepper | undefined {
  for (let node = document.activeElement; node !== null; node = node.parentElement) {
    const holds = shown.filter((stepper) => node.contains(stepper.root()))
    if (holds.length > 0) {
      return holds.length === 1 ? holds[0] : undefined
    }
  }
  return undefined
}

/** The transcript near focus, else the selected panel's, else the first holding own messages. */
function pick(): OwnStepper | undefined {
  const shown = [...steppers].filter((stepper) => stepper.root()?.checkVisibility() === true)
  const focused = nearFocus(shown)
  if (focused !== undefined) {
    return focused
  }
  const panel = selectedPanel()
  const withOwn = shown.filter((stepper) => stepper.hasOwn())
  return withOwn.find((stepper) => panel?.contains(stepper.root()) === true) ?? withOwn[0]
}

const BINDINGS = [
  { chord: CHORDS.ownBack, run: () => pick()?.step('back') },
  { chord: CHORDS.ownForward, run: () => pick()?.step('forward') },
]

/** Alt+[ and Alt+] step back and forward through your own messages in the transcript on screen. */
export function useOwnStepChords(): void {
  useChords(BINDINGS)
}
