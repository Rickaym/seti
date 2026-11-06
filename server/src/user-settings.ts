import type { UserSettings } from '@seti/shared'
import { gitFirstName } from './git.js'
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
