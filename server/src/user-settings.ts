import type { UserSettings } from '@seti/shared'
import { audit } from './audit.js'
import { gitFirstName } from './git.js'
import { DIRECT, type SettingsWrite } from './settings-write.js'
import { userSettings } from './store/user.js'

/** The stored settings; the first read keeps the first name of git's user.name, else no name. */
export async function currentSettings(): Promise<UserSettings> {
  const stored = await userSettings.get()
  if (stored !== undefined) {
    return stored
  }
  const settings = { name: (await gitFirstName()) ?? '' }
  await userSettings.set(settings)
  return { ...settings, theme: null }
}

/** Saves what Seti calls the user, audited, as Settings, General and the settings JSON save it. */
export async function saveName(name: string, write: SettingsWrite = DIRECT): Promise<void> {
  const before = (await currentSettings()).name
  if (before === name) {
    return
  }
  await userSettings.set({ name }, write.db)
  await write.after(async () =>
    audit.record({
      actor: 'user',
      kind: 'system.name_changed',
      subject_type: 'system',
      summary: name === '' ? 'Cleared the name Seti calls you' : `Seti calls you ${name}`,
      detail: { name, was: before },
    }),
  )
}
