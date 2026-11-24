import { readSecondOpinion, RUNTIME_NAMES, SECOND_OPINION_TOOL } from '@seti/shared'
import { MessagesSquare } from 'lucide-react'
import { usd } from '@/lib/money'
import { toolName } from '@/lib/tool-summary'
import { inputString, resultText, type ToolUseBlock } from '@/lib/transcript'
import { cn } from '@/lib/utils'
import { CallStatus, ToolCall, ToolDetails, ToolOutput, type ToolCallProps } from '@/panels/tasks/ToolCall'

const SUMMARY_CHARS = 160

const isSecondOpinion = (block: ToolUseBlock) => {
  const name = toolName(block.name)
  return name.server === 'seti' && name.name === SECOND_OPINION_TOOL
}

/** The answer as the model wrote it: Seti escaped any tag it opened, which reads as text here. */
const shownAnswer = (answer: string) => answer.replaceAll('&lt;', '<')

/** What a second opinion's row shows: the question, the answer once there, who and what it cost. */
function opinionView({ block, result }: Pick<ToolCallProps, 'block' | 'result'>) {
  const question = inputString(block.input, 'question') ?? ''
  const opinion = result === undefined || result.failed ? null : readSecondOpinion(resultText(result))
  const cost = opinion?.costUsd ?? null
  const model = opinion?.model ?? inputString(block.input, 'model') ?? 'another model'
  const estimate = opinion?.estimated === true ? ' est.' : ''
  return {
    question,
    opinion,
    asked: `${result === undefined ? 'Asking' : 'Asked'} ${model}:`,
    cost: cost === null ? null : `${usd(cost)}${estimate}`,
  }
}

/** A second opinion on one line, "Asked <model>: <question>", opening to question and answer. */
function SecondOpinionCall({ taskId, startedAt, block, result, running, background }: ToolCallProps) {
  const { question, opinion, asked, cost } = opinionView({ block, result })
  return (
    <ToolDetails
      className={cn(result?.failed === true && 'border-destructive')}
      resultRow={result?.rowId}
      summary={
        <span className="flex min-w-0 flex-1 items-center gap-2 max-sm:flex-wrap max-sm:gap-y-0.5">
          <MessagesSquare aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          <span className="shrink-0 font-semibold" data-testid="opinion-model">
            {asked}
          </span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground" title={question} data-testid="tool-summary">
            {question.replace(/\s+/g, ' ').slice(0, SUMMARY_CHARS)}
          </span>
          <span className="flex shrink-0 items-center gap-2 max-sm:w-full max-sm:pl-5" data-testid="opinion-meta">
            {cost !== null && (
              <span className="text-muted-foreground tabular-nums" data-testid="opinion-cost">
                {cost}
              </span>
            )}
            <CallStatus block={block} startedAt={startedAt} result={result} running={running} background={background} />
          </span>
        </span>
      }
    >
      <section aria-label="Question" className="space-y-1">
        <p className="font-semibold">Question</p>
        <p className="break-words whitespace-pre-wrap">{question}</p>
      </section>
      {opinion !== null && (
        <section aria-label="Answer" className="space-y-1 border-t border-border pt-2">
          <p className="font-semibold">
            {opinion.model} on {RUNTIME_NAMES[opinion.runtime]}, {opinion.seconds} s
          </p>
          <p className="max-h-96 overflow-auto break-words whitespace-pre-wrap">{shownAnswer(opinion.answer)}</p>
        </section>
      )}
      {opinion === null && result !== undefined && <ToolOutput taskId={taskId} result={result} />}
    </ToolDetails>
  )
}

/** A call row: a second opinion as its own row, any other call as the generic one. */
export function CallRow(props: ToolCallProps) {
  return isSecondOpinion(props.block) ? <SecondOpinionCall {...props} /> : <ToolCall {...props} />
}
