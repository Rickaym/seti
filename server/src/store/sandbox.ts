import { SANDBOX_POLICY_DEFAULT, type SandboxPolicy } from '@seti/shared'
import { now, sql } from '../db.js'

interface PolicyRecord {
  enabled: number
  allowed_domains: string
  hidden_paths: string
  updated_at: string
}

/** The sandbox setting for task sessions; the default until someone saves it. */
export const sandboxPolicy = {
  get: async (): Promise<SandboxPolicy> => {
    const [record] = await sql<PolicyRecord[]>`SELECT enabled, allowed_domains, hidden_paths, updated_at
      FROM sandbox_policy WHERE id = 1`
    if (!record) {
      return SANDBOX_POLICY_DEFAULT
    }
    return {
      enabled: record.enabled === 1,
      allowed_domains: JSON.parse(record.allowed_domains) as string[],
      hidden_paths: JSON.parse(record.hidden_paths) as string[],
      updated_at: record.updated_at,
    }
  },
  save: async (policy: Omit<SandboxPolicy, 'updated_at'>): Promise<SandboxPolicy> => {
    await sql`INSERT INTO sandbox_policy (id, enabled, allowed_domains, hidden_paths, updated_at)
      VALUES (1, ${policy.enabled ? 1 : 0}, ${JSON.stringify(policy.allowed_domains)},
        ${JSON.stringify(policy.hidden_paths)}, ${now()})
      ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, allowed_domains = excluded.allowed_domains,
        hidden_paths = excluded.hidden_paths, updated_at = excluded.updated_at`
    return sandboxPolicy.get()
  },
}
