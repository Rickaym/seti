import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { Hint } from '@/components/Hint'
import { DetailHeader, DetailTitle } from '@/components/SplitPane'
import { Button } from '@/components/ui/button'
import { useOpenQuestions } from '@/hooks/useQuestions'
import { goBack } from '@/lib/route'
import { QuestionsForm } from '@/panels/questions/QuestionsForm'

const back = () => {
  goBack('agents')
}

/** Every agent's open questions in one place; it goes back once a send leaves none open. */
export function QuestionsPage() {
  const open = useOpenQuestions()
  return (
    <div className="flex h-full min-h-0 flex-col">
      <DetailHeader>
        <div className="flex items-center gap-2">
          <Hint text="Back to where you came from">
            <Button variant="ghost" size="icon-sm" className="-ml-2 shrink-0" aria-label="Back" onClick={back}>
              <ArrowLeft />
            </Button>
          </Hint>
          <DetailTitle>Questions</DetailTitle>
        </div>
        <div className="text-xs text-muted-foreground">
          What your agents wait on you for. Each agent goes on once all its questions are answered or dismissed.
        </div>
      </DetailHeader>
      <QuestionsForm
        questions={open}
        submitLabel="Submit all"
        onSettled={(summary) => {
          toast.success(summary)
          back()
        }}
      />
    </div>
  )
}
