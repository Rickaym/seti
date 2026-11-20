import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { openSeedDb } from './db.js'
import { paths } from './env.js'

/** The dependency file a seeded agent holds, 6 KB, so Clean frees a known amount. */
const SEEDED_DEPENDENCY_BYTES = 6000

const workRoot = () => path.join(paths.home, 'work')

const MONTH_AGO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

/** Sets a folder and what is directly in it to a month ago, past the grace for a starting agent. */
function aged(dir: string): void {
  for (const entry of [dir, ...fs.readdirSync(dir).map((name) => path.join(dir, name))]) {
    fs.utimesSync(entry, MONTH_AGO, MONTH_AGO)
  }
}

/** An idle agent whose scratch folder holds source and a node_modules folder of known size. */
export async function seedStorageAgent(title: string): Promise<{ id: string; dir: string }> {
  const id = randomUUID()
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const dir = path.join(workRoot(), `${slug}-${id.slice(0, 8)}`)
  write(path.join(dir, 'src', 'main.ts'), 'export const answer = 42\n')
  write(path.join(dir, 'node_modules', 'left-pad', 'index.js'), 'x'.repeat(SEEDED_DEPENDENCY_BYTES))
  const db = openSeedDb()
  await db.idleTask(id, title, dir, new Date(Date.now() - 60_000).toISOString())
  await db.close()
  return { id, dir }
}

/** A month-old folder no agent owns, and one holding a repository with uncommitted changes. */
export function seedOrphans(tag: string): { plain: string; dirty: string } {
  const plain = path.join(workRoot(), `left-behind-${tag}`)
  write(path.join(plain, 'output.log'), 'x'.repeat(3000))
  aged(plain)
  const dirty = path.join(workRoot(), `unsaved-${tag}`)
  write(path.join(dirty, 'README.md'), '# unsaved\n')
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- uses the git on the runner PATH
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: dirty, env, stdio: 'pipe' })
  aged(dirty)
  return { plain, dirty }
}
