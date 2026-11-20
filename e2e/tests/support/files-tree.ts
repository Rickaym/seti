import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { openSeedDb } from './db.js'
import { paths } from './env.js'

/** The bytes the seeded node_modules holds, which the tree shows as 4 KB. */
export const DEPENDENCY_BYTES = 4096

/** An idle agent whose working folder holds source and a node_modules of a known size. */
export async function seedTreeAgent(): Promise<{ id: string; label: string }> {
  const id = randomUUID()
  const label = `tree-${id.slice(0, 8)}`
  const dir = path.join(paths.root, label)
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'main.ts'), 'export const treeGrown = true\n')
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'x'.repeat(DEPENDENCY_BYTES))
  const db = openSeedDb()
  await db.idleTask(id, 'Tree agent', dir, new Date(Date.now() - 60_000).toISOString())
  await db.close()
  return { id, label }
}

/** A tree row by the start of its accessible name: the folder or file name and a comma. */
export const treeRow = (name: string) => new RegExp(`^${name.replaceAll('.', '\\.')},`)
