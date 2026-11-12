import type { AnswerQuestionsResult, QuestionAnswerItem, SupplySecretResult } from '@seti/shared'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { refreshQuestions } from '@/hooks/useQuestions'
import { sentSummary } from '@/panels/questions/drafts'

/** A secret the user entered, which goes only to its question's own route. */
export interface SecretEntry {
  id: string
  value: string
}

const NOTHING: AnswerQuestionsResult = { answered: 0, dismissed: 0, skipped: 0, resumed: [] }

/** Sends each secret to its own route, one at a time, adding each that went to `sent`. */
async function sendSecrets(secrets: readonly SecretEntry[], sent: string[]): Promise<SupplySecretResult[]> {
  const resumed: SupplySecretResult[] = []
  for (const secret of secrets) {
    resumed.push(
      await apiPost<SupplySecretResult>(`/questions/${encodeURIComponent(secret.id)}/secret`, { value: secret.value }),
    )
    sent.push(secret.id)
  }
  return resumed
}

/** One result for the secrets and the answers that went out together. */
function merged(answers: AnswerQuestionsResult, secrets: number, resumed: readonly SupplySecretResult[]) {
  const agents = [...answers.resumed]
  for (const agent of resumed) {
    if (!agents.some((known) => known.task_id === agent.task_id)) {
      agents.push(agent)
    }
  }
  return { ...answers, answered: answers.answered + secrets, resumed: agents }
}

/** What one send did: its summary line, or null when it failed, and the ids that went out. */
interface SendResult {
  summary: string | null
  sent: readonly string[]
}

/** Sends secrets, answers and dismissals, and says what went out; `onSent` gets the ids that did. */
export function useSend(onSent: (ids: readonly string[]) => void) {
  const [sending, setSending] = useState(false)
  const [summary, setSummary] = useState<string | null>(null)
  const send = async (items: QuestionAnswerItem[], secrets: readonly SecretEntry[] = []): Promise<SendResult> => {
    setSending(true)
    const sent: string[] = []
    let line: string | null = null
    try {
      const resumed = await sendSecrets(secrets, sent)
      const answers =
        items.length === 0 ? NOTHING : await apiPost<AnswerQuestionsResult>('/questions/answers', { items })
      sent.push(...items.map((item) => item.id))
      line = sentSummary(merged(answers, resumed.length, resumed))
      setSummary(line)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      onSent(sent)
      setSending(false)
      refreshQuestions()
    }
    return { summary: line, sent }
  }
  return { send, sending, summary }
}
