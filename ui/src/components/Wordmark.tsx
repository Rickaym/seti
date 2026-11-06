import { Fragment, useEffect, useId, useState, type CSSProperties } from 'react'
import { usePrefersReducedMotion } from '@/hooks/useMedia'
import { decode, PHRASE, SETTLE_MS, TOKENS } from '@/lib/wordmark'

/** Milliseconds since the logo opened, updated every frame until every letter locks. */
function useElapsed(open: boolean, animate: boolean): number {
  const [elapsed, setElapsed] = useState(0)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    setElapsed(0)
  }
  useEffect(() => {
    if (!open || !animate) {
      return undefined
    }
    let start: number | null = null
    let frame = 0
    const step = (now: number) => {
      start ??= now
      const ms = now - start
      if (ms >= SETTLE_MS) {
        setElapsed(SETTLE_MS)
        return
      }
      setElapsed(ms)
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [open, animate])
  return animate ? elapsed : SETTLE_MS
}

/** Where a capital sits in the SETI logo, relative to where it sits in the spelled-out phrase. */
const logoOffset = (letter: number, at: number): CSSProperties =>
  ({ '--from': `calc(${String(letter)} * (1ch + 0.3em) - ${String(at)} * (1ch + 0.06em))` }) as CSSProperties

/** The SETI logo; hovering or keyboard focus decodes it into the phrase it stands for. */
export function Wordmark() {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const open = hovered || focused
  const phraseId = useId()
  const elapsed = useElapsed(open, !usePrefersReducedMotion())

  useEffect(() => {
    if (!open) {
      return undefined
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setHovered(false)
        setFocused(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex --
     The logo takes focus so the keyboard reveals what SETI stands for, as hover does. */
  return (
    <div
      data-slot="app-logo"
      data-open={open}
      role="img"
      aria-label="SETI"
      aria-describedby={phraseId}
      tabIndex={0}
      className="wordmark relative z-10 flex shrink-0 items-center self-stretch outline-none"
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch') {
          setHovered(true)
        }
      }}
      onPointerLeave={() => {
        setHovered(false)
      }}
      onFocus={(event) => {
        setFocused(event.currentTarget.matches(':focus-visible'))
      }}
      onBlur={() => {
        setFocused(false)
      }}
    >
      <span id={phraseId} hidden>
        {PHRASE}
      </span>
      <span className="wordmark-logo text-sm font-semibold tracking-[0.3em]">SETI</span>
      <span aria-hidden className="wordmark-panel">
        <span className="wordmark-backdrop" />
        <span className="wordmark-text text-sm tracking-[0.06em]">
          {TOKENS.map((token, index) => (
            <Fragment key={token.kind === 'word' ? token.capital : token.text}>
              {index > 0 && ' '}
              {token.kind === 'link' ? (
                <span className="wordmark-link">{token.text}</span>
              ) : (
                <span>
                  <span className="wordmark-cap font-semibold" style={logoOffset(token.letter, token.at)}>
                    {token.capital}
                  </span>
                  {decode(token.tail, token.at, elapsed).map((glyph, position) => (
                    <span key={position} className="wordmark-char" data-state={glyph.state} data-noise={glyph.noise}>
                      <span className="wordmark-letter">{glyph.char}</span>
                    </span>
                  ))}
                </span>
              )}
            </Fragment>
          ))}
        </span>
      </span>
    </div>
  )
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex --
     Only the logo above. */
}
