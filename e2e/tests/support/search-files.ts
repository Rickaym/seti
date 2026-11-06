import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { openSeedDb } from './db.js'
import { paths } from './env.js'

/** The line of the panel source that holds the needle, far enough down to need a scroll. */
export const NEEDLE_LINE = 120

/** An idle agent whose working directory holds a long source file, a note and an ignored folder. */
export async function seedSearchAgent(): Promise<{ id: string; dir: string }> {
  const id = randomUUID()
  const dir = path.join(paths.root, `search-${id.slice(0, 8)}`)
  const source = Array.from({ length: 200 }, (_, i) =>
    i + 1 === NEEDLE_LINE ? 'const haystackNeedle = findTheNeedle()' : `const line${String(i + 1)} = ${String(i)}`,
  )
  fs.mkdirSync(path.join(dir, 'src', 'panels'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'panels', 'search-panel.ts'), `${source.join('\n')}\n`)
  fs.writeFileSync(path.join(dir, 'notes.md'), '# Notes\n\nNothing to see.\n')
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'search-panel.js'), 'findTheNeedle()\n')
  const db = openSeedDb()
  await db.idleTask(id, 'Search files', dir, new Date(Date.now() - 60_000).toISOString())
  await db.close()
  return { id, dir }
}
