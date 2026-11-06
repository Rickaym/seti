import { Hint } from '@/components/Hint'
import { Switch } from '@/components/ui/switch'

const HINT = {
  on: 'On by default: every agent without its own choice gets it. Turn it off for one agent in its details, Access.',
  off: 'Off by default: an agent gets it only when its details, Access, turn it on.',
}

/** The Default switch every resource agents may reach shares: SSH hosts, AWS, MCP, packs, plugins. */
export function DefaultSwitch({
  name,
  enabled,
  onChange,
  disabled = false,
}: {
  name: string
  enabled: boolean
  onChange: (enabled: boolean) => void
  disabled?: boolean
}) {
  return (
    <Hint text={enabled ? HINT.on : HINT.off} side="left">
      <span className="flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground">
        Default
        <Switch aria-label={`${name} on by default`} checked={enabled} disabled={disabled} onCheckedChange={onChange} />
      </span>
    </Hint>
  )
}
