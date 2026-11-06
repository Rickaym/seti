import { ChevronDown, ChevronUp, LoaderCircle, UserRound } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { chordAria, chordLabel, CHORDS, type Chord } from '@/components/shortcuts/chords'
import { Button } from '@/components/ui/button'
import type { OwnDirection, OwnNav } from '@/lib/own-messages'

const STEPS: Record<OwnDirection, { label: string; chord: Chord }> = {
  back: { label: 'Previous message of yours', chord: CHORDS.ownBack },
  forward: { label: 'Next message of yours', chord: CHORDS.ownForward },
}

function StepButton({
  direction,
  disabled,
  busy,
  onStep,
}: {
  direction: OwnDirection
  disabled: boolean
  busy: boolean
  onStep: (direction: OwnDirection) => void
}) {
  const { label, chord } = STEPS[direction]
  const Arrow = direction === 'back' ? ChevronUp : ChevronDown
  const Icon = busy ? LoaderCircle : Arrow
  return (
    <Hint text={`${label} (${chordLabel(chord)})`} side="left">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        aria-keyshortcuts={chordAria(chord)}
        disabled={disabled}
        onClick={() => {
          onStep(direction)
        }}
      >
        <Icon className={busy ? 'animate-spin' : undefined} />
      </Button>
    </Hint>
  )
}

/** Steps back and forward through the user's own messages, from the corner of the transcript. */
export function OwnMessageNav({
  nav,
  seeking,
  onStep,
}: {
  nav: OwnNav
  /** The direction of a step still loading its message, or null. */
  seeking: OwnDirection | null
  onStep: (direction: OwnDirection) => void
}) {
  if (!nav.show && seeking === null) {
    return null
  }
  const { position } = nav
  return (
    <div
      role="group"
      aria-label="Your messages"
      data-testid="own-message-nav"
      className="absolute right-3 bottom-3 flex flex-col items-center border border-border bg-background shadow-md"
    >
      <StepButton
        direction="back"
        disabled={nav.back === null || seeking !== null}
        busy={seeking === 'back'}
        onStep={onStep}
      />
      <span className="flex h-5 items-center px-1 text-2xs text-muted-foreground tabular-nums" aria-live="polite">
        {position === null ? (
          <UserRound className="size-3" aria-hidden />
        ) : (
          <>
            <span aria-hidden>{`${String(position.at)}/${String(position.of)}`}</span>
            <span className="sr-only">{`Your message ${String(position.at)} of ${String(position.of)}`}</span>
          </>
        )}
      </span>
      <StepButton
        direction="forward"
        disabled={nav.forward === null || seeking !== null}
        busy={seeking === 'forward'}
        onStep={onStep}
      />
    </div>
  )
}
