import { z } from 'zod'
import { MOD_LOCAL_NAME } from './mod-contributions.js'

/** Seti's own theme, which no mod can take away. */
export const DEFAULT_THEME = 'default'

const optionName = z.string().max(40).regex(MOD_LOCAL_NAME)

/** The theme the user chose for every device: Seti's own, or a mod's as `<mod>.<theme>`. */
export const themeChoice = z.strictObject({
  id: z
    .string()
    .max(81)
    .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9_-]*)?$/, 'A theme is default or <mod>.<theme>'),
  /** Kept across themes, so a theme that offers flavours gets the last one chosen. */
  flavour: optionName.nullable(),
  accent: optionName.nullable(),
})
export type ThemeChoice = z.output<typeof themeChoice>

/** How Seti addresses the user, as in the start page's "Your move, {name}", and their theme. */
export const userSettingsInput = z
  .object({
    name: z.string().trim().min(1, 'Type a name').max(40, 'Keep it under 40 characters').optional(),
    theme: themeChoice.optional(),
  })
  .refine((input) => input.name !== undefined || input.theme !== undefined, 'Say what to change')
export type UserSettingsInput = z.input<typeof userSettingsInput>

export interface UserSettings {
  name: string
  /** Null until the user picks one, and Seti shows its own theme until then. */
  theme: ThemeChoice | null
}
