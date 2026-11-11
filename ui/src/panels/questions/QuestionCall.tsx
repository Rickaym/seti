import { answerText, type Question } from '@seti/shared'
import { MessageCircleQuestion } from 'lucide-react'
import { useEffect, useState } from 'react'
import { apiGet } from '@/api'
import { Button } from '@/components/ui/button'
import { useAgentQuestionCount } from '@/hooks/useQuestions'
import { navigate } from '@/lib/route'
import type { ToolUseBlock } from '@/lib/transcript'
import { QUESTIONS_ROUTE } from '@/panels/questions/route'

/** Claude Code's tool for asking the user, whose calls show as their questions and answers. */
export const ASK_TOOL = 'AskUserQuestion'

const STATUS_TEXT: Record<Question['status'], string> = {
  open: 'Waiting for you',
  answered: 'Answered',
  dismissed: 'Dismissed',
  expired: 'Expired: the agent stopped waiting',
}

/** The questions an agent asked in one call, from its records, read again as its state changes. */
function useCallQuestions(taskId: string, toolUseId: string, changed: string): Question[] {
  const [found, setFound] = useState<Question[]>([])
  useEffect(() => {
    let live = true
    apiGet<Question[]>(`/questions?task_id=${encodeURIComponent(taskId)}&all=true`)
      .then((all) => {
        if (live) {
          setFound(all.filter((question) => question.tool_use_id === toolUseId).sort((a, b) => a.position - b.position))
        }
      })
      .catch(() => {
        // The card falls back to the call's own input.
      })
    return () => {
      live = false
    }
  }, [taskId, toolUseId, changed])
  return found
}

interface Asked {
  header: string
  prompt: string
}

function askedOf(input: unknown): Asked[] {
  const list = typeof input === 'object' && input !== null && 'questions' in input ? input.questions : null
  return Array.isArray(list)
    ? list.flatMap((item: unknown) => {
        if (typeof item !== 'object' || item === null) {
          return []
        }
        const record = item as Record<string, unknown>
        const prompt = typeof record.question === 'string' ? record.question : ''
        const header = typeof record.header === 'string' ? record.header : prompt
        return [{ header, prompt }]
      })
    : []
}

const answerLine = (question: Question | undefined) => {
  if (question === undefined) {
    return null
  }
  if (question.status !== 'answered' || question.answer === null) {
    return STATUS_TEXT[question.status]
  }
  const relayed = question.answered_by === 'ea' ? ' (through the EA)' : ''
  return `${answerText(question.answer)}${relayed}`
}

/** An AskUserQuestion call in the transcript: each question and, once settled, its answer. */
export function QuestionCall({ taskId, block, done }: { taskId: string; block: ToolUseBlock; done: boolean }) {
  const open = useAgentQuestionCount(taskId)
  const records = useCallQuestions(taskId, block.id, `${String(done)}/${String(open)}`)
  const asked = askedOf(block.input)
  const waiting = records.some((question) => question.status === 'open')
  return (
    <div className="space-y-1.5 border border-border px-3 py-2 text-xs" data-testid="question-call">
      <div className="flex items-center gap-1.5 font-semibold">
        <MessageCircleQuestion aria-hidden className="size-3.5 text-muted-foreground" />
        <span className="flex-1">
          {asked.length === 1 ? 'Asked you' : `Asked you ${String(asked.length)} questions`}
        </span>
        {waiting && (
          <Button
            size="xs"
            onClick={() => {
              navigate('agents', QUESTIONS_ROUTE)
            }}
          >
            Answer
          </Button>
        )}
      </div>
      <dl className="space-y-1">
        {asked.map((question, index) => {
          const line = answerLine(records[index])
          return (
            <div key={`${String(index)}-${question.header}`}>
              <dt className="text-muted-foreground">
                <span className="font-semibold">{question.header}</span>: {question.prompt}
              </dt>
              {line !== null && <dd className="pl-3">{line}</dd>}
            </div>
          )
        })}
      </dl>
    </div>
  )
}
