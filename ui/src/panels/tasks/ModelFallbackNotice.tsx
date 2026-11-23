import { ShieldAlert, ShieldCheck } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { LinkedText } from '@/components/links/LinkedText'
import { useTasks } from '@/hooks/useTasks'
import { noticeSentence, stillOn, verificationLink, type RefusalChange } from '@/lib/model-fallback'
import { SwitchBackButton } from '@/panels/tasks/FallbackMark'

/** Claude Code moved the agent to a fallback model after a safeguard refused a request. */
export function ModelFallbackNotice({ taskId, change }: { taskId: string; change: RefusalChange }) {
  const task = useTasks().tasks.find((entry) => entry.id === taskId)
  const current = task?.model_fallback
  const verify = verificationLink(change)
  const explanation = change.refusal.explanation ?? ''
  return (
    <div className="border-l-2 border-warning bg-warning/10 text-xs" data-testid="model-fallback-notice">
      <div className="flex items-start gap-2 px-2 py-1.5">
        <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warning-text" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium break-words text-foreground">{noticeSentence(change)}</p>
          {change.refusal.category !== undefined && (
            <p className="text-muted-foreground">Category: {change.refusal.category}</p>
          )}
          {explanation !== '' && (
            <p className="break-words text-muted-foreground">
              <LinkedText text={explanation} />
            </p>
          )}
          {(stillOn(change, current) || verify !== null) && (
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              {stillOn(change, current) && (
                <SwitchBackButton taskId={taskId} fallback={current} running={task?.status === 'running'} />
              )}
              {verify !== null && (
                <Hint text="Apply for the Cyber Verification Program for legitimate security work">
                  <a
                    href={verify}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-muted-foreground underline hover:text-foreground"
                  >
                    <ShieldCheck className="size-3.5" aria-hidden />
                    Verification
                  </a>
                </Hint>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
