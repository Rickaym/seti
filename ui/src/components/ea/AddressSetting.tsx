import { eaSettingsInput, FORM_OF_ADDRESS_MAX, type EaSettings } from '@seti/shared'
import { useState } from 'react'
import { Hint } from '@/components/Hint'
import { Input } from '@/components/ui/input'
import type { EaSettingsState } from './useEaSettings'

function AddressForm({ settings, save }: { settings: EaSettings; save: EaSettingsState['save'] }) {
  const [address, setAddress] = useState(settings.form_of_address)
  const [invalid, setInvalid] = useState<string | null>(null)
  const commit = () => {
    const parsed = eaSettingsInput.safeParse({ ...settings, form_of_address: address })
    if (!parsed.success) {
      setInvalid(parsed.error.issues[0]?.message ?? 'Check the form of address')
      return
    }
    setInvalid(null)
    if (parsed.data.form_of_address !== settings.form_of_address) {
      void save(parsed.data)
    }
  }
  return (
    <>
      <Hint text="A title or name the EA uses now and then; leave it empty for none" side="top">
        <Input
          aria-label="Address as"
          placeholder="No title"
          value={address}
          maxLength={FORM_OF_ADDRESS_MAX}
          aria-invalid={invalid !== null}
          onChange={(e) => {
            setAddress(e.target.value)
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            }
          }}
          className="h-8 w-40 max-md:w-full"
        />
      </Hint>
      {invalid !== null && (
        <span role="alert" className="text-destructive">
          {invalid}
        </span>
      )}
    </>
  )
}

/** How the EA addresses the user: no title by default, or a word or name the user picks. */
export function AddressSetting({ state }: { state: EaSettingsState }) {
  const { settings, error, save } = state
  return (
    <div className="flex flex-col items-end gap-1 max-md:items-stretch">
      {settings === null ? (
        <span className="text-muted-foreground">{error ?? 'Loading'}</span>
      ) : (
        <AddressForm key={settings.updated_at ?? 'default'} settings={settings} save={save} />
      )}
      {settings !== null && error !== null && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
    </div>
  )
}
