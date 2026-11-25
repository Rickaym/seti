import {
  ArrowRightLeft,
  CircleStop,
  Eraser,
  FastForward,
  MemoryStick,
  RotateCw,
  ShieldCheck,
  ShieldOff,
  TimerOff,
} from 'lucide-react'
import { isFailureNote, type SetiPayload } from '@/lib/seti-notes'
import { FailureLine } from '@/panels/tasks/FailureNotice'
import { Line } from '@/panels/tasks/TranscriptLines'

const SESSION_ICONS = { fresh: Eraser, restarted: RotateCw, continued: ArrowRightLeft }

/** A note from Seti: memory, a restart, a stopped process, Seti control, a timeout, a failure. */
export function SetiNote({ payload }: { payload: SetiPayload }) {
  if (payload.memory !== undefined) {
    return (
      <Line icon={MemoryStick} error={payload.ended_turn === true}>
        {payload.error}
      </Line>
    )
  }
  if (payload.session !== undefined) {
    return <Line icon={SESSION_ICONS[payload.session]}>{payload.error}</Line>
  }
  if (payload.stopped === true) {
    return <Line icon={CircleStop}>{payload.error}</Line>
  }
  if (payload.seti_control !== undefined) {
    const off = payload.seti_control === 'off' || payload.seti_control === false
    return <Line icon={off ? ShieldOff : ShieldCheck}>{payload.error}</Line>
  }
  if (payload.bypass !== undefined) {
    return <Line icon={FastForward}>{payload.error}</Line>
  }
  if (payload.timed_out !== undefined) {
    const at = new Date(payload.timed_out)
    return (
      <Line icon={TimerOff}>
        {payload.error}{' '}
        <time dateTime={payload.timed_out} title={at.toLocaleString()}>
          {at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </time>
      </Line>
    )
  }
  return isFailureNote(payload) ? <FailureLine raw={payload.error} /> : <Line icon={RotateCw}>{payload.error}</Line>
}
