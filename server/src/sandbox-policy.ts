import { sandboxPolicyInput, type SandboxPolicy, type SandboxPolicyInput } from '@seti/shared'
import { audit } from './audit.js'
import { refuseAgent } from './ea-guard.js'
import { sandboxPolicy } from './store/sandbox.js'

const added = (before: readonly string[], after: readonly string[]) => after.filter((entry) => !before.includes(entry))

async function auditChange(before: SandboxPolicy, after: SandboxPolicy): Promise<void> {
  const state = after.enabled ? 'on' : 'off'
  const turned = before.enabled === after.enabled ? '' : ` turned ${state}`
  await audit.record({
    actor: 'user',
    kind: 'system.sandbox_changed',
    subject_type: 'system',
    summary: `Task sandbox${turned === '' ? ' settings changed' : turned}`,
    detail: {
      enabled: after.enabled,
      was_enabled: before.enabled,
      domains_added: added(before.allowed_domains, after.allowed_domains),
      domains_removed: added(after.allowed_domains, before.allowed_domains),
      hidden_added: added(before.hidden_paths, after.hidden_paths),
      hidden_removed: added(after.hidden_paths, before.hidden_paths),
    },
  })
}

/** Saves the sandbox setting, its allowlist and hidden paths, audited; only the user does. */
export async function saveSandboxPolicy(input: SandboxPolicyInput): Promise<SandboxPolicy> {
  refuseAgent('change the sandbox')
  const before = await sandboxPolicy.get()
  const saved = await sandboxPolicy.save(sandboxPolicyInput.parse(input))
  await auditChange(before, saved)
  return saved
}

/** Adds one entry to the allowlist every sandboxed agent shares. */
export async function allowForEveryAgent(entry: string): Promise<SandboxPolicy> {
  const policy = await sandboxPolicy.get()
  if (policy.allowed_domains.includes(entry)) {
    return policy
  }
  const { enabled, allowed_domains: domains, hidden_paths: hidden } = policy
  return saveSandboxPolicy({ enabled, allowed_domains: [...domains, entry], hidden_paths: hidden })
}
