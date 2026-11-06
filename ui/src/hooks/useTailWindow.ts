import { useCallback, useMemo, useState } from 'react'
import { grownFrom, WHOLE, windowStart } from '@/lib/tail-window'
import type { TranscriptSource } from '@/panels/tasks/TranscriptPane'

/** Loaded rows the window adds each time the view scrolls up to its top. */
const STEP = 60

interface Windowed extends TranscriptSource {
  jumpTo: (id: number) => Promise<void>
}

/** The newest `size` loaded rows, null for all; scrolling up reveals more, as a server page would. */
export function useTailWindow<T extends Windowed>(source: T, size: number | null): T {
  const { messages, loadOlder: loadServerPage, jumpTo: jumpOnServer } = source
  const [from, setFrom] = useState<number | null>(null)
  const windowed = size !== null && source.stretch?.detached !== true && from !== WHOLE
  const ids = useMemo(() => messages.map((row) => row.id), [messages])
  const start = windowed ? windowStart(ids, from, size) : 0
  const firstShown = ids[start]

  if (from === null && firstShown !== undefined) {
    setFrom(firstShown)
  }

  const loadOlder = useCallback(
    async (limit?: number) => {
      if (start === 0 || limit !== undefined) {
        setFrom(WHOLE)
        return loadServerPage(limit)
      }
      setFrom(grownFrom(ids, start, STEP))
      return Promise.resolve(true)
    },
    [start, ids, loadServerPage],
  )

  const jumpTo = useCallback(
    async (id: number) => {
      if (firstShown !== undefined && id < firstShown) {
        setFrom(WHOLE)
      }
      return jumpOnServer(id)
    },
    [firstShown, jumpOnServer],
  )

  const shown = useMemo(() => (start === 0 ? messages : messages.slice(start)), [messages, start])
  if (!windowed) {
    return source
  }
  return { ...source, messages: shown, hasOlder: source.hasOlder || start > 0, loadOlder, jumpTo }
}
