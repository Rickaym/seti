import type { SettingNote } from '@seti/shared'
import {
  ArrowRightLeft,
  CircleStop,
  Eraser,
  FastForward,
  FolderX,
  KeyRound,
  MemoryStick,
  Plug,
  RotateCw,
  Shield,
  ShieldCheck,
  ShieldOff,
  TimerOff,
  type LucideIcon,
} from 'lucide-react'
import { isFailureNote, type SetiPayload } from '@/lib/seti-notes'
import { EditedLine } from '@/panels/tasks/EditedLine'
import { FailureLine } from '@/panels/tasks/FailureNotice'
import { RefusedHostLine } from '@/panels/tasks/RefusedHostLine'
import { Line } from '@/panels/tasks/TranscriptLines'

const SESSION_ICONS = { fresh: Eraser, restarted: RotateCw, continued: ArrowRightLeft }

const SETTING_ICONS: Record<SettingNote, LucideIcon> = {
  sandbox: Shield,
  credential: KeyRound,
  access: Plug,
  home: FolderX,
}

/** A note from Seti: memory, restart, a setting, timeout, refused host, edit or failure. */
export function SetiNote({ taskId, payload }: { taskId: string; payload: SetiPayload }) {
  if (payload.edited !== undefined) {
    return <EditedLine mark={payload.edited} />
  }
  if (payload.refused_host !== undefined) {
    return <RefusedHostLine taskId={taskId} host={payload.refused_host} count={payload.refused_count ?? 1} />
  }
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
  if (payload.setting !== undefined) {
    return <Line icon={SETTING_ICONS[payload.setting]}>{payload.error}</Line>
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
