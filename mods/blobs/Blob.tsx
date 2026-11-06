import type { TaskDisplayStatus } from '@seti/mod-api'
import type { CSSProperties } from 'react'
import { BODY, Eyes, Mark, Mouth } from './Face'
import { blobLook, type BlobSettings } from './look'

interface FigureProps {
  status: TaskDisplayStatus
  agent: { id: string; color: string | null } | null
  settings: BlobSettings
  /** A bookmark sits low and left in its box, leaving the top-right corner for its mark. */
  bookmark: boolean
}

const BOOKMARK_FRAME = 'translate(-1.5 2) scale(0.95)'

/** A marker has no mark, so its view crops to the body and the face reads at 14 px. */
const VIEW = { bookmark: ['0 0 24 24', '0 6 24 12'], marker: ['2 2 20 20', '2 7 20 10'] } as const

/** The blob itself: one flat squircle in its agent's colour, with the face of its status. */
export function BlobFigure({ status, agent, settings, bookmark }: FigureProps) {
  const { expression, delay } = blobLook(status, agent?.id ?? null)
  const style: CSSProperties & Record<'--blob-delay', string> = { '--blob-delay': delay }
  const frame = bookmark ? BOOKMARK_FRAME : undefined
  const [view, eyes] = VIEW[bookmark ? 'bookmark' : 'marker']
  return (
    <span
      className={bookmark ? 'seti-blob seti-blob-bookmark' : 'seti-blob'}
      data-expression={expression}
      data-faded={status === 'stopped'}
      data-blob-size={settings.size}
      data-animate={settings.animation}
      data-tinted={agent !== null && agent.color !== null}
      data-testid={bookmark ? 'blob-bookmark' : 'status-blob'}
      style={style}
      aria-hidden
    >
      <span className="seti-blob-squash">
        <svg viewBox={view}>
          <g transform={frame}>
            <path className="skin" d={BODY} />
            <Mouth expression={expression} />
          </g>
          {bookmark && <Mark expression={expression} />}
        </svg>
        <span className="seti-blob-look">
          <svg viewBox={eyes}>
            <g transform={frame}>
              <Eyes expression={expression} />
            </g>
          </svg>
        </span>
      </span>
    </span>
  )
}
