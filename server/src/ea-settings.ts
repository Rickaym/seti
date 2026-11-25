import { eaLanguageName, type EaSettings, type EaSettingsInput } from '@seti/shared'
import { audit } from './audit.js'
import { DIRECT, type SettingsWrite } from './settings-write.js'
import { eaSettings } from './store/ea.js'

/** The change a person cares about: the language, else the form of address, else the wake word. */
function settingsSummary(before: EaSettings, saved: EaSettings): string {
  if (saved.language !== before.language) {
    return `EA language set to ${eaLanguageName(saved.language)}`
  }
  if (saved.form_of_address !== before.form_of_address) {
    return saved.form_of_address === ''
      ? 'EA addresses the user with no title'
      : `EA addresses the user as "${saved.form_of_address}"`
  }
  const wake = saved.wake_enabled ? `on, "${saved.wake_phrase}"` : 'off'
  return `EA wake word ${wake}`
}

/** Saves the EA's settings, keeping the form of address and language the input leaves out. */
export async function saveEaSettings(input: EaSettingsInput, write: SettingsWrite = DIRECT): Promise<EaSettings> {
  const before = await eaSettings.get()
  const saved = await eaSettings.save(
    {
      ...input,
      form_of_address: input.form_of_address ?? before.form_of_address,
      language: input.language ?? before.language,
    },
    write.db,
  )
  await write.after(async () =>
    audit.record({
      actor: 'user',
      kind: 'ea.settings_changed',
      subject_type: 'ea',
      summary: settingsSummary(before, saved),
      detail: {
        wake_enabled: saved.wake_enabled,
        wake_phrase: saved.wake_phrase,
        keep_awake_seconds: saved.keep_awake_seconds,
        join_on_open: saved.join_on_open,
        form_of_address: saved.form_of_address,
        language: saved.language,
        was_enabled: before.wake_enabled,
        was_form_of_address: before.form_of_address,
        was_language: before.language,
      },
    }),
  )
  return saved
}
