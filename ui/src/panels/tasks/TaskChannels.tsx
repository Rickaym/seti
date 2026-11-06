import { SubscribedChannels } from '@/panels/settings/channels/SubscribedChannels'

export function TaskChannels({ taskId, onCount }: { taskId: string; onCount: (count: number) => void }) {
  return (
    <SubscribedChannels
      listPath={`/tasks/${taskId}/channels`}
      subscriber={{ target: 'task', task_id: taskId }}
      addHint="Send a channel's events to this agent as updates"
      testId="task-channels"
      onCount={onCount}
    />
  )
}
