import type { Share } from '@seti/shared'
import { Zap } from 'lucide-react'
import { useId } from 'react'
import { apiPut } from '@/api'
import { Hint } from '@/components/Hint'
import { Switch } from '@/components/ui/switch'
import { useBusy } from '@/hooks/useBusy'

const LIVE_LINE =
  "Runs this page's scripts in the visitor's browser, isolated from Seti. The page can still reach the internet."

const LIVE_HINT = `${LIVE_LINE} Off, visitors see a copy without scripts. Visitors can always open that static view.`

interface LiveProps {
  checked: boolean
  disabled?: boolean
  onChange: (on: boolean) => void
}

/** The Live switch of an HTML file's link: on, its page runs its scripts in an isolated frame. */
export function LiveSwitch({ checked, disabled = false, onChange }: LiveProps) {
  const id = useId()
  return (
    <div className="flex items-start gap-2">
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} className="mt-0.5" />
      <label htmlFor={id} className="grid gap-0.5">
        <Hint text={LIVE_HINT}>
          <span className="inline-flex w-fit items-center gap-1">
            <Zap className="size-3.5" aria-hidden />
            Live
          </span>
        </Hint>
        <span className="text-xs text-muted-foreground">{LIVE_LINE}</span>
      </label>
    </div>
  )
}

/** The Live switch of a link that exists, saved as soon as it changes. */
export function ShareLive({ share, onChange }: { share: Share; onChange: (share: Share) => void }) {
  const { busy, run } = useBusy()
  const set = (on: boolean) =>
    void run(async () => {
      onChange(await apiPut<Share>(`/shares/${share.id}/live`, { live: on }))
    })
  return <LiveSwitch checked={share.live} disabled={busy} onChange={set} />
}
