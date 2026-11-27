import { FileClock, Pencil } from 'lucide-react'
import { Hint } from '@/components/Hint'
import type { ToolUseBlock } from '@/lib/transcript'
import { CallInput } from '@/panels/tasks/ToolInput'
import type { FullSource } from '@/panels/tasks/TrimmedText'
import type { SentCall } from '@/panels/tasks/sent-calls'

/** Marks a call row that shows what the user's edit sent in place of the agent's draft. */
export function EditedTag() {
  return (
    <Hint text="You edited this call before it ran. This row shows what ran; open it for the agent's draft.">
      <span data-testid="tool-edited" className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
        <Pencil aria-hidden className="size-3" />
        edited
      </span>
    </Hint>
  )
}

/** The call as the agent wrote it, under the call as it ran. */
function DraftInput({ block, source, taskId }: { block: ToolUseBlock; source: FullSource | null; taskId: string }) {
  return (
    <section aria-label="Agent's draft" data-testid="tool-draft" className="space-y-1 border-t border-border pt-2">
      <p className="flex items-center gap-1 text-muted-foreground">
        <FileClock aria-hidden className="size-3" />
        Agent&apos;s draft
      </p>
      <CallInput block={block} source={source} taskId={taskId} />
    </section>
  )
}

interface RanProps {
  block: ToolUseBlock
  /** The call as it ran, when the user edited it before allowing it. */
  sent: SentCall | undefined
  source: FullSource | null
  taskId: string
}

/** A call's input as it ran: the agent's own, or the user's edit with the agent's draft under it. */
export function RanInput({ block, sent, source, taskId }: RanProps) {
  if (sent === undefined) {
    return <CallInput block={block} source={source} taskId={taskId} />
  }
  return (
    <>
      <CallInput block={{ ...block, input: sent.input }} source={null} taskId={taskId} />
      <DraftInput block={block} source={source} taskId={taskId} />
    </>
  )
}
