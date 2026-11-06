import type { ModDetail, ModSettingField } from '@seti/shared'
import { Bell, ToggleRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { apiGet, errorText } from '@/api'
import { ToggleButton } from '@/components/ToggleButton'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { SettingRow, SettingsBody, SettingsCard, SettingsHeader } from '../layout'
import type { SettingsViewProps } from '../pages'
import { modOfSettingsKey } from './mod-settings-key'
import { useModSettingsSave, type Save } from './use-mod-settings-save'

const settingRowId = (key: string) => `mod-setting-${key}`

/** The control of one setting, drawn from the field the manifest declares. */
function FieldControl({
  name,
  field,
  value,
  save,
}: {
  name: string
  field: ModSettingField
  value: unknown
  save: Save
}) {
  if (field.type === 'boolean') {
    const on = value === true
    return (
      <ToggleButton
        pressed={on}
        onPressedChange={(next) => {
          save({ settings: { [name]: next } })
        }}
        icon={ToggleRight}
        label={field.title}
        hint={on ? `Turn ${field.title} off` : `Turn ${field.title} on`}
      />
    )
  }
  if (field.type === 'string' && field.options !== undefined) {
    return (
      <NativeSelect
        size="sm"
        aria-label={field.title}
        value={String(value)}
        onChange={(event) => {
          save({ settings: { [name]: event.target.value } })
        }}
      >
        {field.options.map((option) => (
          <NativeSelectOption key={option} value={option}>
            {option}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    )
  }
  const numeric = field.type === 'number'
  return (
    <Input
      aria-label={field.title}
      className="h-8 w-56 max-md:w-full"
      type={numeric ? 'number' : 'text'}
      defaultValue={String(value)}
      onBlur={(event) => {
        const text = event.target.value
        if (text !== String(value)) {
          save({ settings: { [name]: numeric ? Number(text) : text } })
        }
      }}
    />
  )
}

/** A mod's settings and notification kinds, drawn by Seti from what its manifest declares. */
export function ModSettingsCards({
  detail,
  save,
  target = null,
}: {
  detail: ModDetail
  save: Save
  /** The setting a link pointed at, shaded and scrolled to. */
  target?: string | null
}) {
  return (
    <div className="space-y-4">
      {detail.settings.length > 0 && (
        <SettingsCard title="Settings">
          {detail.settings.map(({ key, field, value }) => (
            <SettingRow
              key={key}
              id={settingRowId(key)}
              marked={key === target}
              label={field.title}
              description={field.description}
              stack
            >
              <FieldControl name={key} field={field} value={value} save={save} />
            </SettingRow>
          ))}
        </SettingsCard>
      )}
      {detail.notifications.length > 0 && (
        <SettingsCard title="Notifications">
          {detail.notifications.map((kind) => (
            <SettingRow key={kind.id} label={kind.title} description={kind.description ?? undefined}>
              <ToggleButton
                pressed={kind.enabled}
                onPressedChange={(on) => {
                  save({ notifications: { [kind.id]: on } })
                }}
                icon={Bell}
                label={kind.title}
                hint={`${kind.enabled ? 'Stop notifying' : 'Notify'} on every device`}
              />
            </SettingRow>
          ))}
        </SettingsCard>
      )}
    </div>
  )
}

/** A mod's page in the settings list, for a mod that is on and has settings. */
export function ModSettingsPage({ page, detail: target }: SettingsViewProps) {
  const id = modOfSettingsKey(page)
  const [detail, setDetail] = useState<ModDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    apiGet<ModDetail>(`/mods/${id}`).then(
      (next) => {
        if (live) {
          setDetail(next)
        }
      },
      (e: unknown) => {
        if (live) {
          setError(errorText(e))
        }
      },
    )
    return () => {
      live = false
    }
  }, [id])
  const save = useModSettingsSave(id, setDetail)
  const loaded = detail !== null
  useEffect(() => {
    const row = loaded && target !== null ? document.getElementById(settingRowId(target)) : null
    row?.scrollIntoView({ block: 'center' })
    row?.querySelector('button')?.focus({ preventScroll: true })
  }, [loaded, target])
  return (
    <SettingsBody narrow header={<SettingsHeader title={detail?.name ?? 'Mod'} description={detail?.description} />}>
      {error !== null && <p className="text-sm text-destructive">{error}</p>}
      {detail !== null && <ModSettingsCards detail={detail} save={save} target={target} />}
    </SettingsBody>
  )
}
