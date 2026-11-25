import { splitHandover, type HandoverParts } from '@seti/shared'
import { Bot, CircleStop, Inbox, RotateCcw, ScrollText } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PromptText } from '@/panels/tasks/AttachmentChips'
import { QueueNote, type PromptRow } from '@/panels/tasks/QueueNote'
import { Line } from '@/panels/tasks/TranscriptLines'
import { Spoken } from '@/panels/tasks/TranscriptMarks'

const updates = (count: number) => `${String(count)} ${count === 1 ? 'update' : 'updates'}`

/** The brief Seti added after a first message, closed to one line until opened. */
function BriefFold({ parts }: { parts: HandoverParts }) {
  return (
    <details data-testid="handover-brief" className="group text-xs">
      <summary className="flex min-h-6 w-fit cursor-pointer items-center gap-1.5 text-muted-foreground hover:text-foreground pointer-coarse:min-h-11">
        <ScrollText className="size-3.5 shrink-0" aria-hidden />
        Brief of {parts.from}
      </summary>
      <div className="mt-1 border-l-2 border-border pl-3 whitespace-pre-wrap text-muted-foreground">{parts.brief}</div>
    </details>
  )
}

/** A message to the agent: the user's own, an automatic turn for updates, or a retry. */
export function PromptEntry({ taskId, row, voice }: { taskId: string; row: PromptRow; voice: boolean }) {
  const { payload } = row
  const inputs = payload.inputs ?? 0
  if (payload.auto === true) {
    return (
      <div className="space-y-1">
        <Line icon={Inbox}>
          {payload.queued === undefined
            ? `Seti started a turn to hand the agent ${updates(inputs)}`
            : `Seti queued ${updates(inputs)} for the agent`}
        </Line>
        <QueueNote taskId={taskId} row={row} />
      </div>
    )
  }
  if (payload.retry === true) {
    const whose = payload.from === undefined ? 'your message' : `${payload.from}'s message`
    return <Line icon={RotateCcw}>Retry turn: sent {whose} again</Line>
  }
  const handover = splitHandover(payload.text)
  return (
    <div className="space-y-1" data-own-message={row.id}>
      {payload.interrupted === true && <Line icon={CircleStop}>agent stopped: interrupted by a new message</Line>}
      {payload.from !== undefined && <Line icon={Bot}>Written by {payload.from}, not you</Line>}
      <Spoken voice={voice}>
        <div
          data-find-text=""
          className={cn(
            'border border-primary/30 bg-primary/10 px-3 py-2 text-sm whitespace-pre-wrap',
            payload.queued === 'removed' && 'opacity-60',
          )}
        >
          <PromptText taskId={taskId} text={handover?.prompt ?? payload.text} files={payload.attachments ?? []} />
        </div>
      </Spoken>
      {handover !== null && <BriefFold parts={handover} />}
      <QueueNote taskId={taskId} row={row} />
      {inputs > 0 && <div className="text-2xs text-muted-foreground">sent with {updates(inputs)} from outside</div>}
    </div>
  )
}
