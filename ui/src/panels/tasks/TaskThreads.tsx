import type { ListedThread } from '@seti/shared'
import { ExternalLink, MessageSquareReply, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { RepliesNeedWebhook } from '@/components/RepliesNeedWebhook'
import { Button } from '@/components/ui/button'
import { useThreadReach } from '@/hooks/useThreadReach'

const where = (thread: ListedThread) =>
  thread.channel_name === null ? `channel ${thread.channel}` : `#${thread.channel_name}`

const replies = (count: number) => `${String(count)} ${count === 1 ? 'reply' : 'replies'}`

/** The threads outside Seti the agent posted in and still follows for replies, each with Stop. */
export function TaskThreads({ taskId }: { taskId: string }) {
  const [threads, setThreads] = useState<ListedThread[] | null>(null)
  const reach = useThreadReach()

  useEffect(() => {
    let current = true
    apiGet<ListedThread[]>(`/tasks/${taskId}/threads`)
      .then((found) => {
        if (current) {
          setThreads(found.filter((thread) => thread.stopped_at === null))
        }
      })
      .catch((e: unknown) => toast.error(errorText(e)))
    return () => {
      current = false
    }
  }, [taskId])

  if (threads === null) {
    return <span className="text-muted-foreground">Loading...</span>
  }
  if (threads.length === 0) {
    return <span className="text-muted-foreground">None</span>
  }
  const stop = async (thread: ListedThread) => {
    try {
      await apiPost(`/tasks/${taskId}/threads/${String(thread.id)}/stop`)
      setThreads(threads.filter((entry) => entry.id !== thread.id))
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  return (
    <div className="grid gap-1">
      <ul className="grid gap-1" aria-label="Followed threads" data-testid="task-threads">
        {threads.map((thread) => (
          <li key={thread.id} className="flex min-w-0 items-center gap-2">
            <MessageSquareReply className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <Hint text={thread.channel_name === null ? 'Seti has not seen this channel name yet' : thread.channel}>
              <span className="min-w-0 truncate">{where(thread)}</span>
            </Hint>
            <span className="shrink-0 text-muted-foreground">{replies(thread.replies)}</span>
            {thread.url !== null && (
              <a
                href={thread.url}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open the thread in ${where(thread)}`}
                className="relative shrink-0 text-muted-foreground hover:text-foreground pointer-coarse:after:absolute pointer-coarse:after:-inset-3"
              >
                <ExternalLink className="size-3.5" />
              </a>
            )}
            <Hint text="Stop following: replies there no longer reach the agent">
              <Button
                size="xs"
                variant="outline"
                className="ml-auto pointer-coarse:min-h-11"
                aria-label={`Stop following ${where(thread)}`}
                onClick={() => void stop(thread)}
              >
                <X />
                Stop
              </Button>
            </Hint>
          </li>
        ))}
      </ul>
      {reach?.reading === 0 && <RepliesNeedWebhook />}
    </div>
  )
}
