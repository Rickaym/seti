import fs from 'node:fs'
import path from 'node:path'
import { projectSlug } from './sandbox-mounts.js'

/** Moves a session's transcript to the project folder of `cwd`, the one a sandbox mounts. */
export function moveSessionTo(claudeHome: string, sessionId: string, cwd: string): void {
  const projects = path.join(claudeHome, 'projects')
  const target = path.join(projects, projectSlug(cwd))
  const file = `${sessionId}.jsonl`
  if (fs.existsSync(path.join(target, file)) || !fs.existsSync(projects)) {
    return
  }
  const source = fs
    .readdirSync(projects, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(projects, entry.name))
    .find((dir) => fs.existsSync(path.join(dir, file)))
  if (source === undefined) {
    return
  }
  fs.mkdirSync(target, { recursive: true, mode: 0o700 })
  fs.renameSync(path.join(source, file), path.join(target, file))
  const subagents = path.join(source, sessionId)
  if (fs.existsSync(subagents) && !fs.existsSync(path.join(target, sessionId))) {
    fs.renameSync(subagents, path.join(target, sessionId))
  }
}
