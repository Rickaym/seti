import type { ModelFallbackMessage } from '@seti/shared'
import { ShieldAlert, ShieldCheck } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { useTasks } from '@/hooks/useTasks'
import { linkParts, noticeSentence, stillOn, verificationLink } from '@/lib/model-fallback'
import { SwitchBackButton } from '@/panels/tasks/FallbackMark'

function Explanation({ text }: { text: string }) {
  return (
    <p className="break-words text-muted-foreground">
      {linkParts(text).map((part, index) =>
        part.href === undefined ? (
          <span key={index}>{part.text}</span>
        ) : (
          <a key={index} href={part.href} target="_blank" rel="noreferrer" className="underline hover:text-foreground">
            {part.text}
          </a>
        ),
      )}
    </p>
  )
}

/** Claude Code moved the agent to a fallback model after a safeguard refused a request. */
export function ModelFallbackNotice({ taskId, message }: { taskId: string; message: ModelFallbackMessage }) {
  const task = useTasks().tasks.find((entry) => entry.id === taskId)
  const current = task?.model_fallback
  const verify = verificationLink(message)
  const explanation = message.api_refusal_explanation ?? ''
  return (
    <div className="border-l-2 border-warning bg-warning/10 text-xs" data-testid="model-fallback-notice">
      <div className="flex items-start gap-2 px-2 py-1.5">
        <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warning-text" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium break-words text-foreground">{noticeSentence(message)}</p>
          {message.api_refusal_category !== null && message.api_refusal_category !== undefined && (
            <p className="text-muted-foreground">Category: {message.api_refusal_category}</p>
          )}
          {explanation !== '' && <Explanation text={explanation} />}
          {(stillOn(message, current) || verify !== null) && (
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              {stillOn(message, current) && (
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
