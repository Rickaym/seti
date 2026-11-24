import {
  compactRuleInput,
  cpuCapInput,
  isJsonObject,
  memoryCapInput,
  themeChoice,
  type AttentionTiers,
  type AutoArchiveInput,
  type EaSettingsInput,
  type SettingsProblem,
} from '@seti/shared'
import type { z } from 'zod'
import { updateAutoArchive } from '../archive.js'
import { updateCompactSettings } from '../compact.js'
import { updateCpuCap } from '../cpu-cap.js'
import { updateDreamSettings } from '../dreams/settings.js'
import { saveEaSettings } from '../ea-settings.js'
import { setMcpDefault } from '../mcp-selection.js'
import { updateMemoryCap } from '../memory-cap.js'
import { saveModSettings } from '../mods/actions.js'
import { saveTheme } from '../mods/themes.js'
import { changeNotificationSettings } from '../notifications.js'
import type { SettingsWrite } from '../settings-write.js'
import { saveName } from '../user-settings.js'

type Section = Record<string, unknown>

/** A JSON write that a section's own rules refuse, named by path like a schema error. */
export class SectionProblem extends Error {
  readonly problems: SettingsProblem[]

  constructor(problems: SettingsProblem[]) {
    super(problems.map((problem) => problem.message).join('; '))
    this.problems = problems
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** The value parsed by the route's own schema, so its cross-field rules hold for JSON too. */
function parsed<T extends z.ZodType>(schema: T, value: unknown, path: readonly string[]): z.output<T> {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new SectionProblem(
      result.error.issues.map((issue) => ({ path: [...path, ...issue.path.map(String)], message: issue.message })),
    )
  }
  return result.data
}

/** Saves one section through the services its settings page calls, given its old and new values. */
type SectionWriter = (next: Section, prev: Section, write: SettingsWrite) => Promise<void>

async function general(next: Section, prev: Section, write: SettingsWrite): Promise<void> {
  if (!same(next.theme, prev.theme)) {
    if (next.theme === null) {
      throw new SectionProblem([
        { path: ['app', 'general', 'theme'], message: "Choose a theme; default is Seti's own" },
      ])
    }
    await saveTheme(parsed(themeChoice, next.theme, ['app', 'general', 'theme']), write)
  }
  if (!same(next.name, prev.name)) {
    await saveName(typeof next.name === 'string' ? next.name : '', write)
  }
}

async function lifecycle(next: Section, prev: Section, write: SettingsWrite): Promise<void> {
  if (!same(next.auto_archive, prev.auto_archive)) {
    await updateAutoArchive(next.auto_archive as AutoArchiveInput, write)
  }
  if (!same(next.compaction, prev.compaction)) {
    const rule = parsed(compactRuleInput, next.compaction, ['agents', 'lifecycle', 'compaction'])
    await updateCompactSettings(rule, 'user', write)
  }
  if (!same(next.dreaming, prev.dreaming) && isJsonObject(next.dreaming)) {
    const { zone, ...rest } = next.dreaming
    await updateDreamSettings(zone === null ? rest : next.dreaming, write)
  }
}

async function resources(next: Section, prev: Section, write: SettingsWrite): Promise<void> {
  if (!same(next.memory_cap, prev.memory_cap)) {
    const cap = parsed(memoryCapInput, next.memory_cap, ['agents', 'resources', 'memory_cap'])
    await updateMemoryCap(cap, 'user', write)
  }
  if (!same(next.cpu_cap, prev.cpu_cap)) {
    await updateCpuCap(parsed(cpuCapInput, next.cpu_cap, ['agents', 'resources', 'cpu_cap']), 'user', write)
  }
}

async function mcpServers(next: Section, prev: Section, write: SettingsWrite): Promise<void> {
  const now = (next.defaults ?? {}) as Record<string, boolean>
  const was = (prev.defaults ?? {}) as Record<string, boolean>
  const removed = Object.keys(was).filter((name) => !(name in now))
  if (removed.length > 0) {
    const message = 'A server stays listed while Claude Code knows it; set it to true or false'
    throw new SectionProblem(
      removed.map((name) => ({ path: ['capabilities', 'mcp_servers', 'defaults', name], message })),
    )
  }
  for (const [name, enabled] of Object.entries(now)) {
    if (was[name] !== enabled) {
      await setMcpDefault(name, enabled, write)
    }
  }
}

/** The writers of the sections a JSON write may change; `JSON_WRITABLE` lists their keys. */
export const SECTION_WRITERS: Record<string, SectionWriter> = {
  'app.general': general,
  'app.notifications': async (next, _prev, write) => {
    await changeNotificationSettings(next.tiers as AttentionTiers, write)
  },
  'app.ea': async (next, _prev, write) => {
    await saveEaSettings(next as EaSettingsInput, write)
  },
  'agents.lifecycle': lifecycle,
  'agents.resources': resources,
  'capabilities.mcp_servers': mcpServers,
}

/** Saves the settings of each mod whose settings changed. */
export async function writeMods(next: Section, prev: Section, write: SettingsWrite): Promise<void> {
  for (const [id, mod] of Object.entries(next)) {
    const now = isJsonObject(mod) && isJsonObject(mod.settings) ? mod.settings : {}
    const before = prev[id]
    const was = isJsonObject(before) && isJsonObject(before.settings) ? before.settings : {}
    const changed = Object.fromEntries(Object.entries(now).filter(([key, value]) => !same(value, was[key])))
    if (Object.keys(changed).length > 0) {
      await saveModSettings(id, changed, write)
    }
  }
}
