import { MessageCircleQuestion } from 'lucide-react'
import { CountBadge } from '@/components/CountBadge'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { useAgentQuestionCount, useOpenQuestions } from '@/hooks/useQuestions'
import { navigate } from '@/lib/route'
import { QUESTIONS_ROUTE } from '@/panels/questions/route'

const openQuestions = () => {
  navigate('agents', QUESTIONS_ROUTE)
}

const questionCount = (count: number) => (count === 1 ? '1 question' : `${String(count)} questions`)

/** Opens the Questions page from the Agents list with how many are open; hidden while none are. */
export function QuestionsButton() {
  const count = useOpenQuestions().length
  if (count === 0) {
    return null
  }
  return (
    <Hint text={`Questions: ${questionCount(count)} wait on you`}>
      <Button
        variant="ghost"
        size="icon-sm"
        className="relative"
        aria-label={`Questions, ${questionCount(count)} open`}
        onClick={openQuestions}
      >
        <MessageCircleQuestion />
        <CountBadge aria-hidden>{count}</CountBadge>
      </Button>
    </Hint>
  )
}

/** The agent's open questions in its header, which open the Questions page; hidden while none are. */
export function AgentQuestionsButton({ taskId, compact = false }: { taskId: string; compact?: boolean }) {
  const count = useAgentQuestionCount(taskId)
  if (count === 0) {
    return null
  }
  return (
    <Hint text="Answer it on the Questions page, with every other agent's">
      <Button
        variant="outline"
        size={compact ? 'icon-sm' : 'sm'}
        className="relative"
        aria-label={`Answer ${questionCount(count)}`}
        onClick={openQuestions}
      >
        <MessageCircleQuestion />
        {compact ? <CountBadge aria-hidden>{count}</CountBadge> : questionCount(count)}
      </Button>
    </Hint>
  )
}
