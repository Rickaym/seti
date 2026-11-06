import { randomUUID } from 'node:crypto'
import { AWS_SETTINGS_DEFAULT, type AwsSettings, type ProfileAgent } from '@seti/shared'
import { now, sql } from '../db.js'

export interface ProfileRow {
  id: string
  name: string
  aws: AwsSettings
  created_at: string
  updated_at: string
}

interface ProfileRecord {
  id: string
  name: string
  aws_role_arn: string | null
  aws_external_id: string | null
  aws_region: string
  aws_session_minutes: number
  created_at: string
  updated_at: string
}

const toProfile = (r: ProfileRecord): ProfileRow => ({
  id: r.id,
  name: r.name,
  aws: {
    role_arn: r.aws_role_arn,
    external_id: r.aws_external_id,
    region: r.aws_region,
    session_minutes: r.aws_session_minutes,
    updated_at: r.updated_at,
  },
  created_at: r.created_at,
  updated_at: r.updated_at,
})

/** Credentials, the bundles agents pick, and which tasks use them. */
export const profiles = {
  list: async (): Promise<ProfileRow[]> =>
    (
      await sql<ProfileRecord[]>`SELECT * FROM credential_profile
        ORDER BY (id = 'default') DESC, lower(name), id`
    ).map(toProfile),
  get: async (id: string): Promise<ProfileRow | undefined> => {
    const [record] = await sql<ProfileRecord[]>`SELECT * FROM credential_profile WHERE id = ${id}`
    return record && toProfile(record)
  },
  create: async (name: string): Promise<ProfileRow> => {
    const id = randomUUID()
    const at = now()
    await sql`INSERT INTO credential_profile (id, name, aws_role_arn, aws_external_id, aws_region, aws_session_minutes,
        created_at, updated_at)
      VALUES (${id}, ${name}, NULL, NULL, ${AWS_SETTINGS_DEFAULT.region}, 60, ${at}, ${at})`
    const created = await profiles.get(id)
    if (created === undefined) {
      throw new Error('The profile was not stored')
    }
    return created
  },
  rename: async (id: string, name: string): Promise<void> => {
    await sql`UPDATE credential_profile SET name = ${name}, updated_at = ${now()} WHERE id = ${id}`
  },
  setAws: async (id: string, aws: Omit<AwsSettings, 'updated_at'>): Promise<void> => {
    await sql`UPDATE credential_profile SET aws_role_arn = ${aws.role_arn}, aws_external_id = ${aws.external_id},
      aws_region = ${aws.region}, aws_session_minutes = ${aws.session_minutes}, updated_at = ${now()}
      WHERE id = ${id}`
  },
  /** Marks a change that restarts the sessions of the profile's tasks, such as a new token. */
  touch: async (id: string): Promise<void> => {
    await sql`UPDATE credential_profile SET updated_at = ${now()} WHERE id = ${id}`
  },
  remove: async (id: string): Promise<boolean> =>
    (await sql`DELETE FROM credential_profile WHERE id = ${id}`).count > 0,
  agents: async (id: string): Promise<ProfileAgent[]> =>
    sql<ProfileAgent[]>`SELECT id, title, sandbox = 1 AS sandbox FROM task
      WHERE profile_id = ${id} AND archived_at IS NULL ORDER BY updated_at DESC`,
  agentCounts: async (): Promise<Map<string, number>> =>
    new Map(
      (
        await sql<{ profile_id: string; count: number }[]>`SELECT profile_id, count(*)::int AS count FROM task
          WHERE archived_at IS NULL GROUP BY profile_id`
      ).map((row) => [row.profile_id, row.count]),
    ),
}
