import type { ChannelAttention, ChannelProblem } from '@seti/shared'
import { RadioTower } from 'lucide-react'
import { ItemHint, StatusBarItem } from '@/components/status-bar/StatusBarItem'
import { channelsTone } from '@/components/status-bar/tone'
import { useChannelsSummary } from '@/hooks/useSummaries'
import { navigate } from '@/lib/route'

const PROBLEM: Record<ChannelProblem, string> = {
  failing: 'failing',
  stale: 'overdue',
  erroring: 'last run failed',
}

const line = (entry: ChannelAttention) => `${entry.name} (${entry.source}): ${PROBLEM[entry.problem]}`

/** Shows only while a poller or reminder is failing, erroring or overdue; opens Channels. */
export function ChannelsItem() {
  const { data } = useChannelsSummary()
  if (!data || data.attention.length === 0) {
    return null
  }
  const n = data.attention.length
  const label = `${String(n)} ${n === 1 ? 'channel needs' : 'channels need'} a look`
  return (
    <StatusBarItem
      label={label}
      name="Channels"
      tone={channelsTone(data)}
      tooltip={
        <ItemHint title={label}>
          {data.attention.map((entry) => (
            <span key={entry.id}>{line(entry)}</span>
          ))}
          <span>Click for Channels.</span>
        </ItemHint>
      }
      onClick={() => {
        navigate('settings', 'channels')
      }}
    >
      <RadioTower className="size-3" />
      <span>{n}</span>
    </StatusBarItem>
  )
}
