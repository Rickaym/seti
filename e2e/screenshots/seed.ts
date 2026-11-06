import fs from 'node:fs'
import path from 'node:path'
import { NOW } from './clock.js'
import { GUIDE_MARKDOWN, type DemoRepo } from '../../server/src/demo/content/cast.js'
import { seedAgents as seedCast, type SeedPlan } from '../../server/src/store/demo-seed.js'
import { openSeedDb, type SeedDb } from '../tests/support/db.js'
import { paths } from '../tests/support/env.js'
import { makePdf } from '../tests/support/share-files.js'

export { AGENTS, PR_URL } from '../../server/src/demo/content/cast.js'

export const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()

/** The folder the guide agent wrote, which its Files panel lists. */
function guideFolder(): string {
  const dir = path.join(paths.root, 'acme-docs')
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'docs', 'migration-v2.md'), GUIDE_MARKDOWN)
  fs.writeFileSync(path.join(dir, 'docs', 'migration-v2.pdf'), makePdf(2, 'Migrating to API v2'))
  const written = new Date(NOW - 50 * 60_000)
  for (const name of ['migration-v2.md', 'migration-v2.pdf']) {
    fs.utimesSync(path.join(dir, 'docs', name), written, written)
  }
  return dir
}

/** The demo cast at NOW, through this worker's database. */
export function seedPlan(db: SeedDb, docs = ''): SeedPlan {
  return {
    run: db.run,
    now: NOW,
    repoDir: (repo: DemoRepo) => (repo === 'acme/docs' ? docs : `/srv/${repo}`),
  }
}

export async function seedAgents(): Promise<void> {
  const db = openSeedDb()
  await seedCast(seedPlan(db, guideFolder()))
  await db.close()
}

/** Shares record when they were made; this puts them where the rest of the demo sits in time. */
export async function stampShares(): Promise<void> {
  const db = openSeedDb()
  await db.run(`UPDATE share SET created_at = ?, updated_at = ?`, at(45), at(45))
  await db.close()
}
