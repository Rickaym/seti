import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { cn } from '@/lib/utils'

const FLOOR = 0.08

/** Resting heights of mirrored bars, a little taller towards the middle. */
function restLevels(count: number): number[] {
  const center = Math.floor(count / 2)
  return Array.from({ length: count }, (_, i) => FLOOR + 0.06 * (1 - Math.abs(i - center) / Math.max(center, 1)))
}

const barIds = (count: number) => Array.from({ length: count }, (_, i) => `bar-${String(i)}`)

function setLevels(bars: readonly (HTMLSpanElement | null)[], levels: readonly number[]): void {
  bars.forEach((bar, i) => {
    bar?.style.setProperty('transform', `scaleY(${String(levels[i] ?? FLOOR)})`)
  })
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Mirrored bars from the low voice band of a track; the loudest band sits in the middle. */
function useLevels(track: MediaStreamTrack | null, bars: RefObject<(HTMLSpanElement | null)[]>, rest: number[]) {
  useEffect(() => {
    const row = bars.current
    const center = Math.floor(rest.length / 2)
    setLevels(row, rest)
    if (track === null || reducedMotion()) {
      return undefined
    }
    const context = new AudioContext()
    const source = context.createMediaStreamSource(new MediaStream([track]))
    const analyser = context.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.75
    source.connect(analyser)
    const bins = new Uint8Array(analyser.frequencyBinCount)
    let frame = 0
    const draw = () => {
      analyser.getByteFrequencyData(bins)
      const levels = rest.map((level, i) => Math.max(level, (bins[1 + Math.abs(i - center)] ?? 0) / 255))
      setLevels(row, levels)
      frame = requestAnimationFrame(draw)
    }
    draw()
    return () => {
      cancelAnimationFrame(frame)
      source.disconnect()
      void context.close()
      setLevels(row, rest)
    }
  }, [track, bars, rest])
}

type MeterTone = 'user' | 'bot'

export function MeterBars({
  track,
  active,
  tone,
  count = 15,
  className,
}: {
  track: MediaStreamTrack | null
  active: boolean
  tone: MeterTone
  count?: number
  className?: string
}) {
  const bars = useRef<(HTMLSpanElement | null)[]>([])
  const rest = useMemo(() => restLevels(count), [count])
  const ids = useMemo(() => barIds(count), [count])
  useLevels(track, bars, rest)
  return (
    <div className={cn('flex h-8 items-center gap-[3px]', className)} aria-hidden="true">
      {ids.map((id, i) => (
        <span
          key={id}
          ref={(el) => {
            bars.current[i] = el
          }}
          className={cn(
            'h-full w-[3px] origin-center transition-colors duration-300',
            !active && 'bg-muted-foreground/35',
            active && tone === 'user' && 'bg-voice-user',
            active && tone === 'bot' && 'bg-voice-bot',
          )}
          style={{ transform: `scaleY(${String(rest[i] ?? FLOOR)})` }}
        />
      ))}
    </div>
  )
}
