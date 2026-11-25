import { slackLookUpNote, slackSendTarget, type PermissionRequest } from '@seti/shared'
import { Search } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { useSlackNames } from '@/lib/slack-names'

function inputOf(request: PermissionRequest): unknown {
  try {
    return JSON.parse(request.input)
  } catch {
    return {}
  }
}

/** The Slack channel or person a request sends to while Seti knows no name for it; else null. */
function useUnnamedTarget(request: PermissionRequest): string | null {
  const target = slackSendTarget(request.tool_name, inputOf(request))
  const names = useSlackNames(target === null ? [] : [target])
  return target !== null && !names.has(target) ? target : null
}

interface Props {
  request: PermissionRequest
  busy: boolean
  /** Whether the agent hears a deny's note; without it, looking up is no use. */
  noted: boolean
  className?: string
  /** Denies the send with a note that asks the agent to look the name up and send again. */
  onLookUp: (note: string) => void
}

/** On a Slack send to a channel Seti cannot name yet, asks the agent to look the name up first. */
export function SlackLookUp({ request, busy, noted, className, onLookUp }: Props) {
  const target = useUnnamedTarget(request)
  if (target === null || !noted) {
    return null
  }
  return (
    <Hint text="Deny for now and ask the agent to look up the name, then send again">
      <Button
        size="sm"
        variant="outline"
        className={className}
        disabled={busy}
        onClick={() => {
          onLookUp(slackLookUpNote(target))
        }}
      >
        <Search />
        Look up
      </Button>
    </Hint>
  )
}
