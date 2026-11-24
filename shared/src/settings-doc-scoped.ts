import { z } from 'zod'
import { INPUT_MODES } from './inputs.js'
import { setiControlLevel } from './seti-control.js'
import { SETTINGS_SECTIONS } from './settings-doc-sections.js'
import {
  documented,
  keyedBy,
  sectionFor,
  settingsSection,
  SETTINGS_DOC_VERSION,
  type SettingsDocReader,
} from './settings-doc.js'

const lifecycle = SETTINGS_SECTIONS['agents.lifecycle'].schema.shape
const resources = SETTINGS_SECTIONS['agents.resources'].schema.shape
const rules = SETTINGS_SECTIONS['security.permissions'].schema.shape.rules

/** One agent's own settings; a null cap or rule follows the default every agent gets. */
export const AGENT_SETTINGS = settingsSection({
  page: 'agent',
  description: "One agent's own settings; null follows the default every agent gets",
  schema: documented(
    {
      title: z.string(),
      color: z.string().nullable(),
      pinned: z.boolean(),
      workspace_id: z.string(),
      notifications_muted: z.boolean(),
      input_mode: z.enum(INPUT_MODES),
      runtime: z.string(),
      requested_model: z.string().nullable(),
      requested_effort: z.string().nullable(),
      dreams: z.boolean(),
      memory_cap: resources.memory_cap.nullable(),
      cpu_cap: resources.cpu_cap.nullable(),
      compaction: lifecycle.compaction.nullable(),
      access: keyedBy(keyedBy(z.boolean())),
      sandbox: z.boolean(),
      home_access: z.boolean(),
      credential: z.string(),
      seti_control: setiControlLevel,
      bypass_until: z.string().nullable(),
      allowed_hosts: z.array(z.string()),
      rules,
      security_access: keyedBy(keyedBy(z.boolean())),
    },
    {
      title: 'Its name',
      color: 'Its colour, a preset name or a hex; null for none',
      pinned: 'Pinned to the top of the list',
      workspace_id: 'The workspace it is in',
      notifications_muted: 'Its turns notify no device',
      input_mode: 'What the composer does with a message while it works: wake, queue or off',
      runtime: 'The program it runs on, such as claude or codex',
      requested_model: 'The model asked for at its start; null for the default',
      requested_effort: 'The effort asked for at its start; null for the default',
      dreams: 'It dreams at night when Dreaming is on',
      memory_cap: 'Its own memory cap; null follows the default',
      cpu_cap: 'Its own CPU cap; null follows the default',
      compaction: 'Its own compaction rule; null follows the default',
      access: 'Whether each MCP server, plugin and pack is on for it, by kind and name',
      sandbox: 'It runs sandboxed',
      home_access: 'Its sandbox has your home folders',
      credential: 'The credential it carries, by name',
      seti_control: 'How far its seti tools reach: off, self or full',
      bypass_until: 'Until when it runs in bypass; null for never',
      allowed_hosts: 'Hosts it may reach besides the shared list',
      rules: 'Permission rules for it alone, by what they decide',
      security_access: 'Whether each SSH host and AWS is on for it',
    },
  ),
  security: [
    'sandbox',
    'home_access',
    'credential',
    'seti_control',
    'bypass_until',
    'allowed_hosts',
    'rules',
    'security_access',
  ],
})

/** One workspace's own settings. */
export const WORKSPACE_SETTINGS = settingsSection({
  page: 'workspace',
  description: "One workspace's own settings",
  schema: documented(
    { name: z.string(), position: z.number().int(), dreams: z.boolean() },
    {
      name: 'Its name',
      position: 'Its place in the list, from 0',
      dreams: 'Its agents dream at night when Dreaming is on',
    },
  ),
  security: [],
})

/** The schema of one agent's or workspace's document, as a reader sees it. */
export function scopedDocSchema(key: 'agent' | 'workspace', reader: SettingsDocReader): z.ZodObject {
  const section = key === 'agent' ? AGENT_SETTINGS : WORKSPACE_SETTINGS
  return z.strictObject({
    version: z.literal(SETTINGS_DOC_VERSION).describe('The shape of this document'),
    revision: z.string().describe('Changes whenever any value in the document does'),
    [key]: sectionFor(section, reader) ?? z.strictObject({}),
  })
}
