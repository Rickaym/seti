import { sql, type Db } from './db.js'
import { MIGRATIONS } from './store/schema.js'

const schemas = new Map<string, Promise<string>>()

/** A schema migrated up to just before `name`, built once per test file and never changed. */
async function schemaBefore(name: string): Promise<string> {
  const found = schemas.get(name)
  if (found) {
    return found
  }
  const schema = `before_${name}`
  const index = MIGRATIONS.findIndex((migration) => migration.name === name)
  const built = sql
    .begin(async (tx) => {
      await tx.unsafe(`CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema}`)
      for (const migration of MIGRATIONS.slice(0, index)) {
        await tx.unsafe(migration.sql)
      }
    })
    .then(() => schema)
  schemas.set(name, built)
  return built
}

/** Seeds the schema before migration `name`, runs it `runs` times, reads the outcome, rolls back. */
export async function migrateWith<T>(
  name: string,
  seed: string,
  read: (tx: Db, schema: string) => Promise<T>,
  runs = 1,
): Promise<T> {
  const migration = MIGRATIONS.find((candidate) => candidate.name === name)
  if (!migration) {
    throw new Error(`There is no migration named ${name}`)
  }
  const schema = await schemaBefore(name)
  const rolledBack = Object.assign(new Error('rolled back'), { outcome: undefined as { value: T } | undefined })
  await sql
    .begin(async (tx) => {
      await tx.unsafe(`SET LOCAL search_path TO ${schema}`)
      await tx.unsafe(seed)
      for (let run = 0; run < runs; run++) {
        await tx.unsafe(migration.sql)
        await migration.run?.(tx)
      }
      rolledBack.outcome = { value: await read(tx, schema) }
      throw rolledBack
    })
    .catch((e: unknown) => {
      if (e !== rolledBack) {
        throw e
      }
    })
  if (!rolledBack.outcome) {
    throw new Error('The migration did not run')
  }
  return rolledBack.outcome.value
}
