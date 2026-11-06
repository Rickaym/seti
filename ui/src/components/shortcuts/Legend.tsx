import type { TaskDisplayStatus } from '@seti/shared'
import {
  Blocks,
  CircleAlert,
  Gauge,
  Headset,
  HeartPulse,
  Lock,
  ShieldCheck,
  UserRound,
  type LucideIcon,
} from 'lucide-react'
import { Fragment } from 'react'
import { StatusLight } from '@/panels/tasks/StatusPill'
import { UnseenDot } from '@/panels/tasks/UnseenDot'
import { statusLabel } from '@/panels/tasks/status-label'

const STATUSES: readonly [TaskDisplayStatus, string][] = [
  ['running', 'Working on a turn'],
  ['idle', 'Waiting for your reply'],
  ['complete', 'Its pull requests landed'],
  ['error', 'Turn failed; needs you'],
  ['interrupted', 'Cut off by a restart; needs you'],
  ['asking', 'Ended its turn with a question; needs you'],
  ['blocked', 'Waits for you to allow a tool call; needs you'],
  ['stopped', 'You stopped it'],
]

const BAR: readonly [LucideIcon | 'dot', string, string][] = [
  [Headset, 'EA', 'Voice assistant; press to call'],
  [CircleAlert, 'need you', 'Agents in the Needs you group'],
  [UserRound, 'Usage', '5-hour fill over dimmed weekly'],
  [Gauge, 'Resources', 'Host memory; triangle: anomalies'],
  [Blocks, 'MCP', 'Servers connected of all'],
  ['dot', 'API', 'Connection to the Seti server'],
  [ShieldCheck, 'Sandbox', 'On or off for agent commands'],
  [Lock, 'Permissions', 'Open lock: tools run unasked'],
  [HeartPulse, 'Health', 'Phone: items after the hairline'],
]

const HEADING = 'mb-1 text-2xs tracking-wider text-muted-foreground uppercase'
const LIST = 'grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1'
const TERM = 'flex items-start gap-2'

/** What the agent list's status shapes and the status bar's items mean. */
export function Legend() {
  return (
    <>
      <section aria-label="Agent status">
        <h3 className={HEADING}>Agent status</h3>
        <dl className={LIST}>
          {STATUSES.map(([status, meaning]) => (
            <Fragment key={status}>
              <dt className={TERM}>
                <span aria-hidden className="mt-0.5 flex">
                  <StatusLight status={status} place="legend" />
                </span>
                {statusLabel(status)}
              </dt>
              <dd className="text-muted-foreground">{meaning}</dd>
            </Fragment>
          ))}
          <dt className={TERM}>
            <span aria-hidden className="mt-1 flex size-3 justify-center">
              <UnseenDot />
            </span>
            unseen
          </dt>
          <dd className="text-muted-foreground">Finished since you last looked</dd>
        </dl>
      </section>
      <section aria-label="Status bar">
        <h3 className={HEADING}>Status bar</h3>
        <dl className={LIST}>
          {BAR.map(([Icon, name, meaning]) => (
            <Fragment key={name}>
              <dt className={TERM}>
                {Icon === 'dot' ? (
                  <span className="mx-0.5 mt-1 size-2 shrink-0 bg-success" aria-hidden />
                ) : (
                  <Icon className="mt-0.5 size-3 shrink-0 text-muted-foreground" aria-hidden />
                )}
                {name}
              </dt>
              <dd className="text-muted-foreground">{meaning}</dd>
            </Fragment>
          ))}
        </dl>
      </section>
    </>
  )
}
