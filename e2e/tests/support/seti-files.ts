import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { openSeedDb } from './db.js'
import { paths } from './env.js'

/** Files Seti writes into every workspace, as the seed writes them. */
export const SETI_WRITTEN = ['members.md', 'task.md', 'chat.md']

/** A row of the Files list by file name. */
export const fileRow = (name: string) => new RegExp(name.replaceAll('.', '\\.'))

/** An idle agent working inside its own workspace, beside Seti's files and a report it wrote. */
export async function seedNestedAgent(): Promise<{ id: string }> {
  const id = randomUUID()
  const workspace = path.join(paths.setiHome, 'workspace', id)
  const cwd = path.join(workspace, 'lead')
  fs.mkdirSync(cwd, { recursive: true })
  for (const name of SETI_WRITTEN) {
    fs.writeFileSync(path.join(workspace, name), `# ${name}\n`)
  }
  fs.writeFileSync(path.join(workspace, 'report.md'), '# Report\n')
  fs.writeFileSync(path.join(cwd, 'ops.log'), 'deployed\n')
  const db = openSeedDb()
  await db.idleTask(id, 'Lead agent', cwd, new Date(Date.now() - 60_000).toISOString())
  await db.close()
  return { id }
}
