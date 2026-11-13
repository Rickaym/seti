import { modelLabel, switchableModel, switchBackPrompt, type ModelFallback } from '@seti/shared'
import { ShieldAlert, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { sendAsUser } from '@/hooks/usePendingSends'
import { fallbackHint } from '@/lib/model-fallback'

/** Marks an agent whose session runs on a fallback model since a safeguard refused a request. */
export function FallbackMark({ fallback }: { fallback: ModelFallback | null }) {
  if (fallback === null) {
    return null
  }
  const hint = fallbackHint(fallback)
  return (
    <Hint text={hint}>
      <span
        role="img"
        aria-label={`Fallback: ${hint}`}
        data-testid="fallback-mark"
        className="inline-flex shrink-0 items-center gap-1 border border-warning/50 px-1.5 py-px text-2xs font-semibold text-warning-text uppercase"
      >
        <ShieldAlert className="size-3" aria-hidden />
        <span className="@max-[24rem]/agent:sr-only">Fallback</span>
      </span>
    </Hint>
  )
}

/** Sends /model with the original model once the agent's turn has ended. */
export function SwitchBackButton({
  taskId,
  fallback,
  running,
}: {
  taskId: string
  fallback: ModelFallback
  running: boolean
}) {
  const original = fallback.original_model
  if (!switchableModel(original)) {
    return null
  }
  const command = switchBackPrompt(original)
  const hint = running
    ? `Available when the agent's turn ends; it then sends ${command}`
    : `Send ${command} to move the agent back to ${modelLabel(original)}`
  const send = () => {
    sendAsUser(taskId, command)
    toast.success(`Switching back to ${modelLabel(original)}`)
  }
  return (
    <span className="inline-flex items-center gap-2">
      <Hint text={hint}>
        <span className="inline-flex">
          <Button variant="outline" size="xs" disabled={running} aria-label="Switch back" onClick={send}>
            <Undo2 />
            Switch back
          </Button>
        </span>
      </Hint>
      {running && <span className="text-2xs text-muted-foreground">after this turn</span>}
    </span>
  )
}
