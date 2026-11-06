import { themeChoice, type ThemeChoice, type UserSettings } from '@seti/shared'
import { now, sql } from '../db.js'

export const userSettings = {
  get: async (): Promise<UserSettings | undefined> => {
    const [row] = await sql<{ name: string; theme: unknown }[]>`SELECT name, theme FROM user_settings WHERE id = 1`
    if (row === undefined) {
      return undefined
    }
    const theme = themeChoice.safeParse(row.theme)
    return { name: row.name, theme: theme.success ? theme.data : null }
  },
  set: async (settings: Pick<UserSettings, 'name'>): Promise<void> => {
    await sql`INSERT INTO user_settings (id, name, updated_at) VALUES (1, ${settings.name}, ${now()})
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`
  },
  /** Saves the theme into the row the first read of the settings created. */
  setTheme: async (theme: ThemeChoice): Promise<void> => {
    await sql`UPDATE user_settings SET theme = ${JSON.stringify(theme)}::text::jsonb, updated_at = ${now()}
      WHERE id = 1`
  },
}
