import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { openSeedDb } from './db.js'
import { paths } from './env.js'
import { unique } from './fixtures.js'

/** An agent from before agents cloned for themselves: in a repo worktree, with an extra directory. */
export async function seedOlderAgent(title: string): Promise<{ id: string; slug: string; notes: string }> {
  const id = randomUUID()
  const slug = unique('e2e/older')
  const notes = path.join(paths.home, `notes-${id.slice(0, 8)}`)
  fs.mkdirSync(notes, { recursive: true })
  const at = new Date().toISOString()
  const db = openSeedDb()
  await db.run(
    `INSERT INTO repo (id, slug, path, base_branch, created_at) VALUES (?, ?, ?, 'main', ?)`,
    slug,
    slug,
    paths.secondCheckout,
    at,
  )
  await db.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, sandbox, home_access, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 1, TRUE, 'idle', ?, ?)`,
    id,
    title,
    slug,
    paths.checkout,
    at,
    at,
  )
  await db.run(`INSERT INTO task_worktree (task_id, repo_id, dir) VALUES (?, ?, ?)`, id, slug, paths.checkout)
  await db.run(`INSERT INTO task_dir (task_id, dir) VALUES (?, ?)`, id, notes)
  await db.close()
  return { id, slug, notes }
}
