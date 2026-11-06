import type { ReactNode } from 'react'
import type { Expression } from './look'

/** The body: a squircle filling 2 to 22 of the 24 by 24 box, which the face below is drawn on. */
export const BODY = 'M12 2C19.6 2 22 4.4 22 12S19.6 22 12 22 2 19.6 2 12 4.4 2 12 2Z'

/** The eyes' centres on the body. */
const L = 8.5
const R = 15.5
const Y = 11

/** Open eyes as rounded capsules, crisp at 16 px. */
const open = (height: number) => (
  <>
    <rect className="fill" x={L - 1.35} y={Y - height / 2} width={2.7} height={height} rx={1.35} />
    <rect className="fill" x={R - 1.35} y={Y - height / 2} width={2.7} height={height} rx={1.35} />
  </>
)

/** Wide eyes raised toward the top of the body, as if looking up at the user. */
const lookingUp = (
  <>
    <ellipse className="fill" cx={L} cy={Y - 1.3} rx={1.75} ry={2.3} />
    <ellipse className="fill" cx={R} cy={Y - 1.3} rx={1.75} ry={2.3} />
  </>
)

/** An arc across each eye: `lift` above zero bows it up (^ ^), below zero down. */
const arcs = (y: number, lift: number) => {
  const arc = (x: number) =>
    `M${String(x - 1.7)} ${String(y)}Q${String(x)} ${String(y - lift)} ${String(x + 1.7)} ${String(y)}`
  return <path className="line" d={arc(L) + arc(R)} />
}

const cross = (x: number) => `M${String(x - 1.3)} ${String(Y - 1.3)}l2.6 2.6m0 -2.6l-2.6 2.6`

/** Each expression's eyes: the part that blinks while running. */
export function Eyes({ expression }: { expression: Expression }): ReactNode {
  switch (expression) {
    case 'happy':
      return open(4.6)
    case 'asking':
    case 'alert':
      return lookingUp
    case 'asleep':
      return arcs(11.6, -2.6)
    case 'content':
      return arcs(12.2, 3)
    case 'error':
      return <path className="line" d={cross(L) + cross(R)} />
    case 'neutral':
      return open(2.9)
  }
}

/** Each expression's mouth, which stays still while the eyes blink. */
export function Mouth({ expression }: { expression: Expression }): ReactNode {
  switch (expression) {
    case 'happy':
      return <path className="line" d="M9.7 15Q12 17.5 14.3 15" />
    case 'content':
      return <path className="line" d="M9.3 14.8Q12 17.9 14.7 14.8" />
    case 'asking':
    case 'alert':
      return <circle className="fill" cx={12} cy={15.9} r={1.1} />
    case 'error':
      return <path className="line" d="M10.1 16.4Q12 14.7 13.9 16.4" />
    case 'neutral':
      return <path className="line" d="M10.6 15.6H13.4" />
    case 'asleep':
      return null
  }
}

/** The small sign in a bookmark's top-right corner, outside the body: ?, ! or a z. */
export function Mark({ expression }: { expression: Expression }): ReactNode {
  switch (expression) {
    case 'asking':
      return (
        <>
          <path className="mark-line" d="M19.5 2.3Q19.6 0.8 21.2 0.8Q22.8 0.8 22.8 2.3Q22.8 3.5 21.2 4V4.5" />
          <circle className="mark-fill" cx={21.2} cy={6.5} r={0.95} />
        </>
      )
    case 'alert':
      return (
        <>
          <path className="mark-line" d="M21.3 0.9V4.3" />
          <circle className="mark-fill" cx={21.3} cy={6.5} r={1} />
        </>
      )
    case 'asleep':
      return <path className="mark-line sleep" d="M19.4 1H22.9L19.4 4.6H22.9" />
    case 'happy':
    case 'content':
    case 'error':
    case 'neutral':
      return null
  }
}
