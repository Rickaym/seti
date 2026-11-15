import { EA_LANGUAGES, eaSettingsInput } from '@seti/shared'
import { Languages } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import type { EaSettingsState } from './useEaSettings'

/** The language the EA listens, speaks and writes in, picked from the ones its speech covers. */
export function LanguageSetting({ state }: { state: EaSettingsState }) {
  const { settings, error, save } = state
  if (settings === null) {
    return <span className="text-muted-foreground">{error ?? 'Loading'}</span>
  }
  return (
    <Hint
      text="The EA listens, speaks and writes in this language; Multilingual follows the one you last used"
      side="top"
    >
      <div className="flex min-w-0 items-center gap-2 max-md:w-full">
        <Languages className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <NativeSelect
          aria-label="Language"
          size="sm"
          value={settings.language}
          onChange={(e) => {
            const parsed = eaSettingsInput.safeParse({ ...settings, language: e.target.value })
            if (parsed.success) {
              void save(parsed.data)
            }
          }}
          className="w-44 min-w-0 max-md:w-full"
        >
          {EA_LANGUAGES.map((language) => (
            <NativeSelectOption key={language.code} value={language.code}>
              {language.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
    </Hint>
  )
}
