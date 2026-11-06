import type { AttentionBrief, AttentionBriefLine, EaUnseenReply } from '@seti/shared'
import { navigate } from '@/lib/route'
import { cn } from '@/lib/utils'
import { focusEaMessage } from './useEaReplies'

const MESSAGES_LISTED = 3

function Line({
  urgent = false,
  title,
  text,
  open,
}: {
  urgent?: boolean
  title: string
  text: string
  open: () => void
}) {
  return (
    <li>
      <button type="button" className="w-full rounded-sm py-0.5 text-left hover:bg-accent" onClick={open}>
        <span className="line-clamp-2 min-w-0">
          <span className={cn('font-medium', urgent && 'text-destructive')}>{title}</span>{' '}
          <span className="text-muted-foreground">{text}</span>
        </span>
      </button>
    </li>
  )
}

const openLine = (line: AttentionBriefLine) => () => {
  if (line.task_id === null) {
    navigate('ea')
  } else {
    navigate('agents', line.task_id)
  }
}

const openReply = (id: number) => () => {
  focusEaMessage(id)
  navigate('ea')
}

const firstLine = (text: string) => text.split('\n').find((line) => line.trim() !== '') ?? text

function heading(brief: AttentionBrief | null, messages: number): string {
  if (brief !== null) {
    return brief.summary
  }
  return `${String(messages)} EA ${messages === 1 ? 'message' : 'messages'}`
}

/**
 * The since-you-left brief: agents that need the user first, then one line per agent that changed
 * in its own words, then the EA's unseen messages. A tap on a line opens that agent or message.
 */
export function BriefToast({
  brief,
  replies,
  beyond,
}: {
  brief: AttentionBrief | null
  replies: readonly EaUnseenReply[]
  beyond: number
}) {
  const shown = replies.slice(-MESSAGES_LISTED)
  const more = (brief?.more ?? 0) + beyond + replies.length - shown.length
  return (
    <div className="w-full space-y-1.5 font-normal" data-testid="attention-brief">
      <p className="font-medium">{heading(brief, replies.length + beyond)}</p>
      <ul className="space-y-0.5 text-sm">
        {brief?.needs_you.map((line) => (
          <Line key={`n-${line.url}`} urgent title={line.title} text={line.text} open={openLine(line)} />
        ))}
        {brief?.changed.map((line, index) => (
          <Line key={`c-${line.url}-${String(index)}`} title={line.title} text={line.text} open={openLine(line)} />
        ))}
        {shown.map((reply) => (
          <Line key={`r-${String(reply.id)}`} title="EA" text={firstLine(reply.text)} open={openReply(reply.id)} />
        ))}
      </ul>
      {more > 0 && <p className="text-xs text-muted-foreground">{`${String(more)} more in Seti`}</p>}
    </div>
  )
}
