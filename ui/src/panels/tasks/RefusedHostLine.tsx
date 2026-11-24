import { Check, Globe, ShieldBan } from 'lucide-react'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Line } from '@/panels/tasks/TranscriptLines'

const ACTION = 'h-6 shrink-0 -my-1 px-1.5 text-2xs pointer-coarse:-my-2.5 pointer-coarse:h-11'

/**
 * A host the agent's sandbox refused, with how many times, and Allow host: the user's own answer
 * to a host request, for this agent or every agent.
 */
export function RefusedHostLine({ taskId, host, count }: { taskId: string; host: string; count: number }) {
  const [open, setOpen] = useState(false)
  const [everyAgent, setEveryAgent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [allowed, setAllowed] = useState(false)
  const scopeId = useId()

  const allow = async () => {
    setBusy(true)
    try {
      await apiPost(`/tasks/${taskId}/refused-hosts`, { host, scope: everyAgent ? 'all' : 'agent' })
      setAllowed(true)
      setOpen(false)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const action = allowed ? (
    <span className="flex shrink-0 items-center gap-1 text-2xs">
      <Check className="size-3" aria-hidden />
      Allowed
    </span>
  ) : (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className={ACTION} title={`Let the agent reach ${host}`}>
          <Globe />
          Allow host
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" className="w-auto max-w-72 gap-2 text-xs">
        <p>Lets the agent reach {host} from its next request.</p>
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Switch id={scopeId} size="sm" checked={everyAgent} onCheckedChange={setEveryAgent} />
          <label htmlFor={scopeId}>All agents</label>
        </span>
        <Button size="sm" disabled={busy} onClick={() => void allow()}>
          <Check />
          Allow
        </Button>
      </PopoverContent>
    </Popover>
  )
  return (
    <Line icon={ShieldBan} action={action}>
      Sandbox refused {host}
      {count > 1 && <span className="tabular-nums"> ({count} times)</span>}
    </Line>
  )
}
