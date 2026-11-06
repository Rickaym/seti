import {
  AWAY_MS,
  TIER_SURFACES,
  URGENT_SURFACES,
  type AttentionTier,
  type NotificationSettings,
  type NotificationStatus,
  type TierSurface,
} from '@seti/shared'
import {
  Archive,
  BellOff,
  BellRing,
  CircleAlert,
  CircleCheck,
  MessageSquare,
  Newspaper,
  Siren,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { apiPut, errorText } from '@/api'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { refreshNotifications } from '@/hooks/useNotifications'
import { SettingRow, SettingsCard } from './layout'

interface TierRow {
  tier: AttentionTier
  label: string
  icon: LucideIcon
  holds: string
  surfaces: readonly TierSurface[]
}

const TIERS: readonly TierRow[] = [
  { tier: 'urgent', label: 'Urgent', icon: Siren, holds: 'Needs you, failed turns and CI', surfaces: URGENT_SURFACES },
  {
    tier: 'active',
    label: 'Active',
    icon: CircleAlert,
    holds: 'Finished turns, reminders, alerts',
    surfaces: TIER_SURFACES,
  },
  {
    tier: 'digest',
    label: 'Digest',
    icon: CircleCheck,
    holds: "Watched agents' routine news",
    surfaces: TIER_SURFACES,
  },
  { tier: 'passive', label: 'Passive', icon: Archive, holds: 'What only the EA needs', surfaces: TIER_SURFACES },
]

const SURFACES: Record<TierSurface, { label: string; icon: LucideIcon; hint: string }> = {
  push: {
    label: 'Push',
    icon: BellRing,
    hint: 'A phone push while you are away, a toast while Seti has focus, the EA call while one is live',
  },
  toast: { label: 'Toast', icon: MessageSquare, hint: 'Only a toast while Seti has focus; otherwise the brief' },
  brief: { label: 'Brief', icon: Newspaper, hint: 'Only the brief when you come back' },
  off: { label: 'Off', icon: BellOff, hint: 'The EA knows; nothing shows' },
}

const AWAY_MINUTES = AWAY_MS / 60_000

function SurfaceSelect({ row, value }: { row: TierRow; value: TierSurface }) {
  const change = async (surface: string) => {
    try {
      await apiPut<NotificationStatus>('/notifications/settings', { [row.tier]: surface })
    } catch (e) {
      toast.error(errorText(e), { duration: Infinity })
    } finally {
      refreshNotifications()
    }
  }
  const current = SURFACES[value]
  return (
    <Select value={value} onValueChange={(surface) => void change(surface)}>
      <SelectTrigger aria-label={`${row.label} tier`} title={current.hint} size="sm" className="w-28">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {row.surfaces.map((surface) => {
          const { label, icon: Icon, hint } = SURFACES[surface]
          return (
            <SelectItem key={surface} value={surface} title={hint}>
              <Icon />
              {label}
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}

/** Where each attention tier reaches the user; one select per tier. */
export function TiersCard({ settings }: { settings: NotificationSettings }) {
  return (
    <SettingsCard title="Tiers">
      {TIERS.map((row) => (
        <SettingRow
          key={row.tier}
          label={row.label}
          description={
            <span className="inline-flex items-center gap-1.5">
              <row.icon className="size-3.5 shrink-0" aria-hidden />
              {row.holds}
            </span>
          }
        >
          <SurfaceSelect row={row} value={settings[row.tier]} />
        </SettingRow>
      ))}
      <p className="px-3 py-2.5 text-muted-foreground">
        {`For every device; needs-you is always urgent. After ${String(AWAY_MINUTES)} minutes with no Seti page in focus and no call, a brief waits for your return. Mute one agent in its settings, under General.`}
      </p>
    </SettingsCard>
  )
}
