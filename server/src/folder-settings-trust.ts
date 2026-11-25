import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Task } from '@seti/shared'
import { audit } from './audit.js'
import { folderSettingsWatch, type WatchedFile } from './store/folder-settings.js'

/** The settings files of an agent's folder whose rules and tool servers its runtime and Seti read. */
const RULE_FILES = ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json'] as const
export type RuleFile = (typeof RULE_FILES)[number]

function digest(file: string): string | null {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

const ruleFiles = (cwd: string) => RULE_FILES.map((name) => ({ name, file: path.join(cwd, name) }))

/** Notes what a watched file holds now: still missing, appeared, or changed since it appeared. */
async function review(task: Task, file: string, entry: WatchedFile | undefined): Promise<void> {
  const hash = digest(file)
  if (hash === null) {
    await folderSettingsWatch.missing(file)
  } else if (entry?.appeared_hash === null) {
    await folderSettingsWatch.appeared(file, hash)
    await audit.record({
      actor: 'system',
      kind: 'task.folder_settings_held',
      subject_type: 'task',
      subject_id: task.id,
      summary: `Held back the allow rules of ${file}, which appeared while an agent could write it`,
      detail: { title: task.title, file },
    })
  } else if (entry !== undefined && entry.appeared_hash !== hash) {
    await folderSettingsWatch.forget(file)
  }
}

/**
 * At a sandboxed session's start: watches the rule files of the agent's folder that are missing,
 * which the session could create where it cannot change an existing one, and reviews those
 * watched before. A file that appeared while watched stays held until its content changes, which
 * only happens outside every agent's session.
 */
export async function watchFolderSettings(task: Task): Promise<void> {
  const files = ruleFiles(task.cwd)
  const watched = new Map((await folderSettingsWatch.of(files.map((f) => f.file))).map((w) => [w.path, w]))
  for (const { file } of files) {
    await review(task, file, watched.get(file))
  }
}

/** The rule files of a folder an agent's session could have written, whose allow rules Seti holds. */
export async function heldFolderSettings(cwd: string): Promise<Set<RuleFile>> {
  const files = ruleFiles(cwd)
  const watched = new Map((await folderSettingsWatch.of(files.map((f) => f.file))).map((w) => [w.path, w]))
  return new Set(
    files.flatMap(({ name, file }) => {
      const entry = watched.get(file)
      const hash = entry === undefined ? null : digest(file)
      return hash !== null && (entry?.appeared_hash === null || entry?.appeared_hash === hash) ? [name] : []
    }),
  )
}
