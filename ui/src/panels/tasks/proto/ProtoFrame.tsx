import type { WireRow } from '@seti/shared'
import { useMemo, type ReactNode } from 'react'
import { BriefView, NowBar } from '@/panels/tasks/proto/BriefView'
import { pinsNeeds, type ChatDesign } from '@/panels/tasks/proto/chat-design'
import { lastOwnMessage, worldState } from '@/panels/tasks/proto/digest'
import { UpdatesStrip } from '@/panels/tasks/proto/parts'

interface ProtoFrameProps {
  design: ChatDesign
  taskId: string
  rows: readonly WireRow[]
  running: boolean
  /** Permission requests, questions and failures. */
  needs: ReactNode
  /** The transcript pane as the design draws it. */
  pane: ReactNode
}

/** Everything a chat prototype draws above the queued strip and the composer. */
export function ProtoFrame({ design, taskId, rows, running, needs, pane }: ProtoFrameProps) {
  const strip = design === 'a' || design === 'a-plus'
  const updates = useMemo(() => (strip ? worldState(rows, lastOwnMessage(rows)) : []), [strip, rows])
  if (design === 'b') {
    return <BriefView taskId={taskId} messages={rows} running={running} needs={needs} history={pane} />
  }
  return (
    <>
      {strip && (
        <UpdatesStrip
          taskId={taskId}
          updates={updates}
          className="shrink-0 border-b border-border bg-background px-5 py-1 max-md:px-3 in-data-agent-frame:px-3"
        />
      )}
      {pane}
      {pinsNeeds(design) && (
        <div className="max-h-[60%] shrink-0 space-y-2 overflow-y-auto border-t border-border px-5 py-2 empty:hidden max-md:px-3 in-data-agent-frame:px-3">
          {needs}
        </div>
      )}
      {design === 'a-plus' && <NowBar messages={rows} running={running} />}
    </>
  )
}
