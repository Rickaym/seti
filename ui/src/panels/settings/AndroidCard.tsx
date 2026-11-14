import type { AndroidAppInput, AndroidAppSettings } from '@seti/shared'
import { Save, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPut } from '@/api'
import { FindableTextarea } from '@/components/find/FindableTextarea'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useBusy } from '@/hooks/useBusy'
import { SettingRow, SettingsCard } from './layout'

/** The form for an app the user builds and signs themselves, inside a collapsed section. */
function SelfBuiltApp({
  settings,
  onChange,
}: {
  settings: AndroidAppSettings
  onChange: (next: AndroidAppSettings) => void
}) {
  const { busy, run } = useBusy()
  const [name, setName] = useState(settings.override?.package_name ?? '')
  const [prints, setPrints] = useState(settings.override?.cert_sha256.join('\n') ?? '')
  const [replace, setReplace] = useState(settings.replace_official)
  const save = async (body: AndroidAppInput, done: string) => {
    if (
      await run(async () => {
        const next = await apiPut<AndroidAppSettings>('/devices/android', body)
        setName(next.override?.package_name ?? '')
        setPrints(next.override?.cert_sha256.join('\n') ?? '')
        setReplace(next.replace_official)
        onChange(next)
      })
    ) {
      toast.success(done)
    }
  }
  const certs = prints.split(/[\s,]+/).filter((print) => print !== '')
  const override = name.trim() === '' && certs.length === 0 ? null : { package_name: name.trim(), cert_sha256: certs }
  return (
    <details className="border-t border-border">
      <summary className="cursor-pointer px-3 py-2.5 text-muted-foreground select-none">
        Self-built app
        {settings.override !== null && <span className="ml-2 font-mono">{settings.override.package_name}</span>}
      </summary>
      <p className="px-3 pb-2 text-muted-foreground">
        Only for an app you build and sign yourself; Seti trusts it next to the official app.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void save({ override, replace_official: replace }, 'Self-built app saved')
        }}
      >
        <SettingRow label="Package name" description="Such as com.example.seti." stack>
          <Input
            aria-label="Package name"
            autoComplete="off"
            spellCheck={false}
            className="w-64 font-mono max-md:w-full"
            value={name}
            onChange={(event) => {
              setName(event.target.value)
            }}
          />
        </SettingRow>
        <SettingRow label="Signing certificates" description="SHA-256 fingerprints, one per line." stack>
          <FindableTextarea
            aria-label="Signing certificates"
            spellCheck={false}
            rows={3}
            boxClassName="w-64 max-md:w-full"
            className="font-mono text-xs"
            value={prints}
            onChange={(event) => {
              setPrints(event.target.value)
            }}
          />
        </SettingRow>
        <SettingRow
          label="Replace official app"
          description="Stop trusting the official app on this Seti; only your build opens it."
        >
          <Switch aria-label="Replace official app" checked={replace} onCheckedChange={setReplace} />
        </SettingRow>
        <div className="flex justify-end gap-2 px-3 py-2">
          {settings.override !== null && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                void save({ override: null, replace_official: false }, 'Self-built app removed')
              }}
            >
              <Trash2 />
              Remove
            </Button>
          )}
          <Button type="submit" size="sm" disabled={busy}>
            <Save />
            Save
          </Button>
        </div>
      </form>
    </details>
  )
}

export function AndroidCard({
  settings,
  onChange,
}: {
  settings: AndroidAppSettings
  onChange: (next: AndroidAppSettings) => void
}) {
  const { official, replace_official: replaced } = settings
  return (
    <SettingsCard title="Android app">
      <SettingRow
        label="Official app"
        description={
          replaced
            ? 'Replaced by your self-built app below.'
            : 'Seti for Android opens this Seti full screen and may use its passkeys. Nothing to set up.'
        }
      >
        <span className="font-mono text-muted-foreground">{official.package_name}</span>
      </SettingRow>
      <SelfBuiltApp settings={settings} onChange={onChange} />
    </SettingsCard>
  )
}
