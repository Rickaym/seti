import { ListCollapse, Monitor, Moon, Sun, type LucideIcon } from 'lucide-react'
import { ToggleButton } from '@/components/ToggleButton'
import { useTheme, type Mode } from '@/components/theme/theme-context'
import { useToolGrouping } from '@/hooks/useToolGrouping'
import { NameCard } from './NameCard'
import { ThemeChoices } from './ThemeChoices'
import { SettingRow, SettingsBody, SettingsCard, SettingsHeader } from './layout'

const MODES: { mode: Mode; label: string; icon: LucideIcon; hint: string }[] = [
  { mode: 'light', label: 'Light', icon: Sun, hint: 'Always light' },
  { mode: 'dark', label: 'Dark', icon: Moon, hint: 'Always dark' },
  { mode: 'system', label: 'System', icon: Monitor, hint: 'Follow the light or dark setting of this device' },
]

function AppearanceCard() {
  const { mode, setMode } = useTheme()
  return (
    <SettingsCard title="Appearance">
      <SettingRow
        label="Color mode"
        stack
        description="Kept per browser. The header button switches between light and dark."
      >
        <div role="group" aria-label="Color mode" className="flex items-center gap-1.5">
          {MODES.map((option) => (
            <ToggleButton
              key={option.mode}
              pressed={mode === option.mode}
              onPressedChange={() => {
                setMode(option.mode)
              }}
              icon={option.icon}
              label={option.label}
              hint={option.hint}
            />
          ))}
        </div>
      </SettingRow>
      <ThemeChoices />
    </SettingsCard>
  )
}

function TranscriptCard() {
  const [grouping, setGrouping] = useToolGrouping()
  return (
    <SettingsCard title="Transcripts">
      <SettingRow
        label="Group tool calls"
        description="Folds a run of tool calls into one row that opens to list them. Kept per browser."
      >
        <ToggleButton
          pressed={grouping}
          onPressedChange={setGrouping}
          icon={ListCollapse}
          label="Group calls"
          hint={grouping ? 'Show every tool call on its own row' : 'Fold runs of tool calls into one row'}
        />
      </SettingRow>
    </SettingsCard>
  )
}

/** What Seti calls you and how it looks in this browser. */
export function GeneralPage() {
  return (
    <SettingsBody
      narrow
      header={<SettingsHeader title="General" description="What Seti calls you and how it looks in this browser." />}
    >
      <div className="space-y-4">
        <NameCard />
        <AppearanceCard />
        <TranscriptCard />
      </div>
    </SettingsBody>
  )
}
