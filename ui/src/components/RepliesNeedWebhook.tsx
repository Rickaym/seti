import { MessageSquareReply } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { navigate } from '@/lib/route'

const WHY =
  'A reply in a Slack thread reaches the agent that posted only through a Slack webhook with Threads on; ' +
  'a poller does not read replies. Open Channels to add one; steps: "Slack thread replies" in docs/setup.md.'

/** Says, quietly, that followed threads have no webhook to bring their replies (THR-8). */
export function RepliesNeedWebhook() {
  return (
    <Hint text={WHY}>
      <button
        type="button"
        className="flex min-h-11 w-fit items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
        data-testid="replies-need-webhook"
        onClick={() => {
          navigate('settings', 'channels')
        }}
      >
        <MessageSquareReply className="size-3.5 shrink-0" aria-hidden />
        Replies need a Slack webhook
      </button>
    </Hint>
  )
}
