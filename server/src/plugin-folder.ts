import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { describeIssues, HttpError } from './http.js'

const MANIFEST = path.join('.claude-plugin', 'plugin.json')
const MARKETPLACE = path.join('.claude-plugin', 'marketplace.json')

const manifestSchema = z.object({
  name: z
    .string({ error: 'name is required' })
    .regex(/^[A-Za-z0-9][\w.-]*$/, 'name must be letters, digits, dots, hyphens or underscores'),
  version: z.string().optional(),
  description: z.string().optional(),
})

export interface PluginManifest {
  name: string
  version: string | null
  description: string
}

/** Expands a leading ~ and requires an absolute path, so a folder never depends on Seti's cwd. */
export function resolvePluginPath(raw: string, home: string = os.homedir()): string {
  const expanded = raw === '~' || raw.startsWith('~/') ? path.join(home, raw.slice(1)) : raw
  if (!path.isAbsolute(expanded)) {
    throw new HttpError(400, 'Use an absolute path, such as /home/me/my-plugin')
  }
  return path.resolve(expanded)
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
  } catch (e) {
    throw new HttpError(400, `${MANIFEST} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Reads the manifest of a Claude Code plugin folder; throws a 400 saying why it is not one. */
export function readPluginFolder(folder: string): PluginManifest {
  const stat = fs.statSync(folder, { throwIfNoEntry: false })
  if (stat === undefined) {
    throw new HttpError(400, `No folder at ${folder}`)
  }
  if (!stat.isDirectory()) {
    throw new HttpError(400, `${folder} is not a folder`)
  }
  const manifestFile = path.join(folder, MANIFEST)
  if (!fs.existsSync(manifestFile)) {
    throw new HttpError(
      400,
      fs.existsSync(path.join(folder, MARKETPLACE))
        ? `${folder} has a marketplace.json but no ${MANIFEST}; add the plugin folder it lists instead`
        : `No ${MANIFEST} in ${folder}; pick the root folder of a Claude Code plugin`,
    )
  }
  const parsed = manifestSchema.safeParse(readJson(manifestFile))
  if (!parsed.success) {
    throw new HttpError(400, `${MANIFEST}: ${describeIssues(parsed.error)}`)
  }
  return {
    name: parsed.data.name,
    version: parsed.data.version ?? null,
    description: parsed.data.description ?? '',
  }
}

/** Why a saved plugin folder would not load now, or null when it still reads as a plugin. */
export function pluginFolderProblem(folder: string): string | null {
  try {
    readPluginFolder(folder)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
