import type { MessageRow } from '@seti/shared'
import { Check, Reply, X, type LucideIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { sendAsUser } from '@/hooks/usePendingSends'
import { askedInRows } from '@/lib/closing-question'

/** The longest label an answer shows; its tooltip holds the whole answer. */
const LABEL_MAX = 28

interface QuickReply {
  label: string
  /** The message a tap sends. */
  text: string
  hint: string
  icon: LucideIcon
}

const YES: QuickReply = { label: 'Yes', text: 'Yes', hint: 'Sends "Yes" as your reply', icon: Check }
const NO: QuickReply = { label: 'No', text: 'No', hint: 'Sends "No" as your reply', icon: X }

const shortLabel = (text: string) => (text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 3).trimEnd()}...` : text)

const optionReply = (text: string): QuickReply => ({
  label: shortLabel(text),
  text,
  hint: `Sends "${text}" as your reply`,
  icon: Reply,
})

/**
 * One-tap answers to the question the agent's reply ended on: Yes and No when either answers it,
 * and the answers the reply listed. A tap sends the answer as the reply box would.
 */
export function QuickReplies({ taskId, messages }: { taskId: string; messages: readonly MessageRow[] }) {
  const asked = useMemo(() => askedInRows(messages), [messages])
  const [sent, setSent] = useState(false)
  const replies = [...(asked.closed ? [YES, NO] : []), ...asked.options.map(optionReply)]
  if (sent || !asked.asks || replies.length === 0) {
    return null
  }
  return (
    <div role="group" aria-label="Quick replies" className="mt-3 flex max-w-full flex-wrap items-center gap-2">
      {replies.map(({ label, text, hint, icon: Icon }, index) => (
        <Hint key={`${String(index)}:${text}`} text={hint} side="top">
          <Button
            size="sm"
            variant="outline"
            className="max-w-full min-w-0 pointer-coarse:min-h-11 pointer-coarse:px-3"
            onClick={() => {
              setSent(true)
              void sendAsUser(taskId, text)
            }}
          >
            <Icon />
            <span className="truncate">{label}</span>
          </Button>
        </Hint>
      ))}
    </div>
  )
}
