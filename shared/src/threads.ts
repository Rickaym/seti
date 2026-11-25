/** Why Seti stopped following a thread: who stopped it, or it went quiet, old or over the cap. */
export type ThreadStopReason = 'user' | 'ea' | 'agent' | 'quiet' | 'age' | 'cap' | 'archived'

/** A thread an agent posted in outside Seti, such as a Slack thread, whose replies can reach it. */
export interface FollowedThread {
  id: number
  task_id: string
  /** Where the thread lives, such as slack. */
  service: string
  /** The workspace, such as a Slack team's domain; empty when the send did not say. */
  space: string
  /** The conversation, such as a Slack channel id. */
  channel: string
  /** The thread's first message id, such as a Slack ts. */
  thread: string
  /** The id of the agent's first message in the thread; only later replies reach it. */
  since: string
  /** A link to the agent's first message there; null when the send gave none. */
  url: string | null
  last_sent_at: string
  last_activity_at: string
  replies: number
  stopped_at: string | null
  stop_reason: ThreadStopReason | null
  created_at: string
}
