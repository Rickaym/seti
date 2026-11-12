import { MessageCircleQuestion, X } from 'lucide-react'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { useAgentQuestions } from '@/hooks/useQuestions'
import { QuestionsForm } from '@/panels/questions/QuestionsForm'

/** One agent's open questions beside it; it closes itself once the agent has none open. */
export function QuestionsDrawer({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { questions, loaded } = useAgentQuestions(taskId)
  const settled = loaded && questions.length === 0
  useEffect(() => {
    if (settled) {
      onClose()
    }
  }, [settled, onClose])
  return (
    <section aria-label="Agent questions" className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <MessageCircleQuestion aria-hidden className="size-4 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">Questions</h2>
        <Hint text="Close Questions; the agent keeps waiting">
          <Button variant="ghost" size="icon-sm" aria-label="Close Questions" onClick={onClose}>
            <X />
          </Button>
        </Hint>
      </div>
      <QuestionsForm
        questions={questions}
        submitLabel="Submit"
        onSettled={(summary) => {
          toast.success(summary)
          onClose()
        }}
      />
    </section>
  )
}
