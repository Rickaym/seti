import type { ClaudeLogin } from '@seti/shared'
import { sql } from '../db.js'

export interface LoginRow extends ClaudeLogin {
  /** Claude Code's account and organization ids, which tell one login from another. */
  identity: string
}

const COLUMNS = sql`id, name, identity, email, organization, plan, created_at, updated_at`

/** Saved Claude logins without their tokens, which the secret store keeps sealed. */
export const loginRows = {
  list: async (): Promise<LoginRow[]> =>
    sql<LoginRow[]>`SELECT ${COLUMNS} FROM claude_login ORDER BY lower(name), created_at`,
  get: async (id: string): Promise<LoginRow | undefined> =>
    (await sql<LoginRow[]>`SELECT ${COLUMNS} FROM claude_login WHERE id = ${id}`).at(0),
  byIdentity: async (identity: string): Promise<LoginRow | undefined> =>
    (await sql<LoginRow[]>`SELECT ${COLUMNS} FROM claude_login WHERE identity = ${identity}`).at(0),
  byName: async (name: string): Promise<LoginRow | undefined> =>
    (await sql<LoginRow[]>`SELECT ${COLUMNS} FROM claude_login WHERE lower(name) = lower(${name})`).at(0),
  insert: async (row: LoginRow): Promise<void> => {
    await sql`INSERT INTO claude_login (id, name, identity, email, organization, plan, created_at, updated_at)
      VALUES (${row.id}, ${row.name}, ${row.identity}, ${row.email}, ${row.organization}, ${row.plan},
        ${row.created_at}, ${row.updated_at})`
  },
  rename: async (id: string, name: string, at: string): Promise<void> => {
    await sql`UPDATE claude_login SET name = ${name}, updated_at = ${at} WHERE id = ${id}`
  },
  describe: async (id: string, about: Pick<ClaudeLogin, 'email' | 'organization' | 'plan'>, at: string) => {
    await sql`UPDATE claude_login SET email = ${about.email}, organization = ${about.organization},
      plan = ${about.plan}, updated_at = ${at} WHERE id = ${id}`
  },
  delete: async (id: string): Promise<boolean> =>
    (await sql`DELETE FROM claude_login WHERE id = ${id} RETURNING id`).length > 0,
}
