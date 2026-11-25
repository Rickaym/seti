import type { Share } from '@seti/shared'
import { AppWindow } from 'lucide-react'
import { useId } from 'react'
import { apiPut } from '@/api'
import { Hint } from '@/components/Hint'
import { Switch } from '@/components/ui/switch'
import { useBusy } from '@/hooks/useBusy'

const RENDER_LINE =
  "Runs this page's scripts in the visitor's browser, isolated from Seti. The page can still reach the internet."

const CODE_LINE = 'Visitors see the file as code.'

const RENDER_HINT = 'On, visitors see the page as a browser shows it. Off shows the file as code.'

interface RenderProps {
  checked: boolean
  disabled?: boolean
  onChange: (on: boolean) => void
}

/** The Render switch of an HTML file's link: on, visitors see the page; off, its code. */
export function RenderSwitch({ checked, disabled = false, onChange }: RenderProps) {
  const id = useId()
  return (
    <div className="flex items-start gap-2">
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} className="mt-0.5" />
      <label htmlFor={id} className="grid gap-0.5">
        <Hint text={RENDER_HINT}>
          <span className="inline-flex w-fit items-center gap-1">
            <AppWindow className="size-3.5" aria-hidden />
            Render
          </span>
        </Hint>
        <span className="text-xs text-muted-foreground">{checked ? RENDER_LINE : CODE_LINE}</span>
      </label>
    </div>
  )
}

/** The Render switch of a link that exists, saved as soon as it changes. */
export function ShareRender({ share, onChange }: { share: Share; onChange: (share: Share) => void }) {
  const { busy, run } = useBusy()
  const set = (on: boolean) =>
    void run(async () => {
      onChange(await apiPut<Share>(`/shares/${share.id}/render`, { render: on }))
    })
  return <RenderSwitch checked={share.render} disabled={busy} onChange={set} />
}
