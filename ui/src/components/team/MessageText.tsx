import type { TeamMessage } from '@seti/shared'
import { memo } from 'react'
import remarkBreaks from 'remark-breaks'
import { CopyReply } from '@/components/CopyReply'
import { Markdown } from '@/components/Markdown'
import { FileLink } from '@/panels/files/FileLink'
import { remarkMentions, type ColorOf } from './remark-mentions'

const mentionColors = ({ message, colorOf }: { message: TeamMessage; colorOf: ColorOf }) =>
  message.mentions.map((mention) => (mention.task_id === null ? '' : (colorOf(mention.task_id) ?? ''))).join()

/** A message's text and Copy reply; only a mentioned agent's new colour renders it again. */
export const MessageText = memo(
  function RenderedMessage({ message, colorOf }: { message: TeamMessage; colorOf: ColorOf }) {
    return (
      <CopyReply text={message.text}>
        <Markdown
          text={message.text}
          plugins={[remarkBreaks, remarkMentions(message.mentions, colorOf)]}
          className="space-y-1.5 text-xs leading-normal"
          fileLink={FileLink}
        />
      </CopyReply>
    )
  },
  (prev, next) => prev.message === next.message && mentionColors(prev) === mentionColors(next),
)
