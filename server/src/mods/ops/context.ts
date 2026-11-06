import { modScoped, Registry, type Disposer, type ModGrantScopes, type ModManifest } from '@seti/shared'
import { filterCovers } from '../scopes.js'
import { settingsWithDefaults } from '../values.js'

const SETTING = /\{\{\s*settings\.([a-z0-9][a-z0-9-]*)\s*\}\}/g
const SETTING_CHARS = 200

/** Context text a running mod adds to agents' system prompts, from its manifest, never at runtime. */
interface ModContextEntry {
  key: string
  mod: string
  text: string
  /** The agents.context filter; undefined for every agent. */
  agents: readonly string[] | undefined
  settings: () => Promise<Record<string, unknown>>
}

const modContexts = new Registry<ModContextEntry>('context provider', (entry) => entry.key)

/** Keeps mod text from closing the wrapper Seti puts around it. */
const contained = (text: string) => text.replaceAll('<', '&lt;')

/** The text with each `{{settings.<key>}}` as the user set it; only short text settings fill in. */
function filled(text: string, settings: Record<string, unknown>): string {
  return text.replace(SETTING, (_match, key: string) => {
    const value = settings[key]
    return typeof value === 'string' ? value.slice(0, SETTING_CHARS) : ''
  })
}

/** The exact text the consent screen quotes, each setting shown by its title, such as [Team]. */
export function contextForConsent(manifest: ModManifest): { id: string; title: string; text: string }[] {
  return manifest.contributes.contextProviders.map((provider) => ({
    id: provider.id,
    title: provider.title,
    text: provider.text.replace(SETTING, (_match, key: string) => {
      const field = manifest.contributes.settings[key]
      return `[${field?.title ?? key}]`
    }),
  }))
}

/** Registers the manifest's context text for the agents its grant covers, tracked by the host. */
export function registerModContext(
  manifest: ModManifest,
  scopes: ModGrantScopes,
  track: (dispose: Disposer) => Disposer,
): void {
  const grant = scopes['agents.context']
  if (grant === undefined) {
    return
  }
  for (const provider of manifest.contributes.contextProviders) {
    track(
      modContexts.register({
        key: modScoped(manifest.id, provider.id),
        mod: manifest.id,
        text: provider.text,
        agents: grant.agents,
        settings: async () => settingsWithDefaults(manifest),
      }),
    )
  }
}

/** The context every running mod adds for this agent, each wrapped and labelled as the mod's. */
export async function modContextPrompt(taskId: string): Promise<string | null> {
  const parts: string[] = []
  for (const entry of modContexts.list()) {
    if (await filterCovers(entry.agents, taskId)) {
      const text = contained(filled(entry.text, await entry.settings()))
      parts.push(
        `<mod_context mod="${entry.mod}">\nWritten by the ${entry.mod} mod, not by the user.\n${text}\n</mod_context>`,
      )
    }
  }
  return parts.length === 0 ? null : parts.join('\n\n')
}
