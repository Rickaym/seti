import type { ModInfo } from '@seti/shared'
import { ChevronRight, Lock, Power } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { ToggleButton } from '@/components/ToggleButton'
import { navigate } from '@/lib/route'
import { cn } from '@/lib/utils'
import { ModGlyph } from './ModGlyph'
import { modBadges, publisherOf, REQUIRED_NOTE, type BadgeTone, type ModBadge } from './mod-list'

const TONES: Readonly<Record<BadgeTone, string>> = {
  muted: 'border-border text-muted-foreground',
  primary: 'border-primary/40 bg-primary/10 text-primary',
  destructive: 'border-destructive/40 bg-destructive/10 text-destructive',
}

function Badge({ badge }: { badge: ModBadge }) {
  return (
    <Hint text={badge.hint}>
      <span
        className={cn(
          'relative z-10 inline-flex h-5 shrink-0 items-center border px-1.5 text-2xs font-medium whitespace-nowrap',
          TONES[badge.tone],
        )}
      >
        {badge.label}
      </span>
    </Hint>
  )
}

/** Where the mod came from and what waits on it, as small labelled chips. */
export function ModBadges({ mod }: { mod: ModInfo }) {
  const badges = modBadges(mod)
  return badges.length === 0 ? null : (
    <span className="flex flex-wrap items-center gap-1">
      {badges.map((badge) => (
        <Badge key={badge.label} badge={badge} />
      ))}
    </span>
  )
}

/** The on/off switch of a mod; the user is always the one who presses it here. */
export function ModToggle({
  mod,
  busy,
  onToggle,
  iconOnly = true,
}: {
  mod: ModInfo
  busy: boolean
  onToggle: (on: boolean) => void
  iconOnly?: boolean
}) {
  const hint = mod.enabled ? `Turn ${mod.name} off` : `Turn ${mod.name} on`
  const stateLabel = mod.enabled ? 'On' : 'Off'
  return (
    <ToggleButton
      pressed={mod.enabled}
      disabled={busy || (mod.problem !== null && !mod.enabled)}
      onPressedChange={onToggle}
      icon={Power}
      label={iconOnly ? mod.name : stateLabel}
      iconOnly={iconOnly}
      hint={mod.problem !== null && !mod.enabled ? mod.problem : hint}
    />
  )
}

/** Where a required mod's switch would be: a lock that says it is always on. */
function AlwaysOn() {
  return (
    <Hint text={REQUIRED_NOTE}>
      <span
        role="img"
        aria-label="Always on"
        className="inline-flex size-7 items-center justify-center text-muted-foreground"
      >
        <Lock aria-hidden className="size-4" />
      </span>
    </Hint>
  )
}

const openMod = (id: string) => {
  navigate('settings', `mods/${id}`)
}

/** One mod in the list: its icon, name, one line of what it does, who made it, and its switch. */
export function ModRow({ mod, busy, onToggle }: { mod: ModInfo; busy: boolean; onToggle: (on: boolean) => void }) {
  return (
    <li
      aria-label={mod.display_name}
      className="relative flex items-center gap-3 border-b border-border px-3 py-3 last:border-b-0 hover:bg-accent/60"
    >
      <ModGlyph icon={mod.icon} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <button
            type="button"
            aria-label={`Open ${mod.display_name}`}
            className="min-w-0 truncate text-left text-sm font-medium outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
            onClick={() => {
              openMod(mod.id)
            }}
          >
            {mod.display_name}
          </button>
          <span className="text-2xs text-muted-foreground tabular-nums">{mod.version}</span>
          <ModBadges mod={mod} />
        </div>
        <p className="truncate">{mod.description}</p>
        <p className="truncate text-2xs text-muted-foreground">{publisherOf(mod)}</p>
      </div>
      <div className="relative z-10 flex shrink-0 items-center gap-1">
        {mod.required ? <AlwaysOn /> : <ModToggle mod={mod} busy={busy} onToggle={onToggle} />}
      </div>
      <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </li>
  )
}
