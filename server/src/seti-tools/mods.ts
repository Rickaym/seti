import { z } from 'zod'
import { done, setiTool, ToolRefusal } from './tool.js'
import { changeMod, listMods } from '../mods/actions.js'
import { saveTheme, themeEntries } from '../mods/themes.js'
import { currentSettings } from '../user-settings.js'

const option = z
  .string()
  .trim()
  .toLowerCase()
  .max(40)
  .regex(/^[a-z][a-z0-9_-]*$/)

/** Turns the mod on or off and saves the settings given, which Seti checks against its manifest. */
async function changeOne(ref: string, enabled?: boolean, settings?: Record<string, unknown>): Promise<string> {
  const wanted = ref.toLowerCase()
  const found = (await listMods()).mods.find((mod) => mod.id === wanted || mod.name.toLowerCase() === wanted)
  if (found === undefined) {
    throw new ToolRefusal(`Seti has no mod "${ref}"; seti_overview with mods lists them.`)
  }
  const changed = await changeMod(found.id, { enabled, settings })
  const values = changed.settings.filter(({ key }) => settings !== undefined && key in settings)
  const saved = values.map(({ field, value }) => `${field.title} is ${JSON.stringify(value)}`)
  const state = enabled === undefined ? [] : [`The ${changed.name} mod is ${changed.enabled ? 'on' : 'off'}.`]
  return [...state, ...(saved.length === 0 ? [] : [`In ${changed.name}, ${saved.join(', ')}.`])].join(' ')
}

/** Picks the theme by its title or id; a flavour or accent left out keeps the one chosen before. */
async function pickTheme(ref: string | undefined, flavour?: string, accent?: string): Promise<string> {
  const current = (await currentSettings()).theme
  const wanted = (ref ?? current?.id ?? 'default').toLowerCase()
  const theme = themeEntries().find((entry) => entry.id === wanted || entry.title.toLowerCase() === wanted)
  if (theme === undefined) {
    throw new ToolRefusal(`Seti has no theme "${ref ?? wanted}"; seti_overview with mods lists them.`)
  }
  const keep = (value: string | undefined, before: string | null | undefined) => value ?? before ?? null
  await saveTheme({ id: theme.id, flavour: keep(flavour, current?.flavour), accent: keep(accent, current?.accent) })
  return `Seti shows the ${theme.title} theme on every device.`
}

const setModEnabled = setiTool({
  name: 'set_mod_enabled',
  description:
    "Turn one of Seti's mods on or off or change its settings, or pick Seti's theme for every device; seti_overview with mods lists them with their settings. Only ordinary bundled and theme mods: third-party and security-sensitive ones are the user's alone, as is safe mode, and required ones stay on. A theme must come from a mod that is on.",
  input: {
    mod: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .optional()
      .describe("The mod's name or id; give enabled or settings with it."),
    enabled: z.boolean().optional().describe('true to turn the mod on, false to turn it off.'),
    settings: z
      .record(z.string().max(40), z.union([z.string().max(2000), z.number(), z.boolean()]))
      .optional()
      .describe('Settings of the mod to change, by key, such as {"pdf": false}; seti_overview with mods lists them.'),
    theme: z.string().trim().min(1).max(81).optional().describe("The theme's title or id, such as Default."),
    flavour: option.optional().describe("A dark flavour the theme offers; left out keeps the user's."),
    accent: option.optional().describe("An accent the theme offers; left out keeps the user's."),
  },
  run: async ({ mod, enabled, settings, theme, flavour, accent }) => {
    const picking = theme !== undefined || flavour !== undefined || accent !== undefined
    const changing = enabled !== undefined || settings !== undefined
    if ((mod === undefined) === changing || (mod === undefined && !picking)) {
      throw new ToolRefusal(
        'The mod or theme argument is missing: give a mod with enabled or settings, or a theme, flavour or accent.',
      )
    }
    const lines = [
      ...(mod !== undefined ? [await changeOne(mod, enabled, settings)] : []),
      ...(picking ? [await pickTheme(theme, flavour, accent)] : []),
    ]
    return done(lines.join(' '))
  },
})

export const MOD_TOOLS = [setModEnabled]
