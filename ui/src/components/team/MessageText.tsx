import type { TeamMessage } from '@seti/shared'
import { memo } from 'react'
import remarkBreaks from 'remark-breaks'
import { CopyReply } from '@/components/CopyReply'
import { Markdown } from '@/components/Markdown'
import { LedgerTaskContext } from '@/lib/references/source-matches'
import { FileLink } from '@/panels/files/FileLink'
import { remarkMentions, type ColorOf } from './remark-mentions'

const mentionColors = ({ message, colorOf }: { message: TeamMessage; colorOf: ColorOf }) =>
  message.mentions.map((mention) => (mention.task_id === null ? '' : (colorOf(mention.task_id) ?? ''))).join()

/**
 * A message's text and Copy reply; only a mentioned agent's new colour renders it again. An
 * agent's references are checked against its own evidence ledger.
 */
export const MessageText = memo(
  function RenderedMessage({ message, colorOf }: { message: TeamMessage; colorOf: ColorOf }) {
    return (
      <CopyReply text={message.text}>
        <LedgerTaskContext value={message.author_kind === 'task' ? message.author_task_id : null}>
          <Markdown
            text={message.text}
            plugins={[remarkBreaks, remarkMentions(message.mentions, colorOf)]}
            className="space-y-1.5 text-xs leading-normal"
            fileLink={FileLink}
          />
        </LedgerTaskContext>
      </CopyReply>
    )
  },
  (prev, next) => prev.message === next.message && mentionColors(prev) === mentionColors(next),
)
