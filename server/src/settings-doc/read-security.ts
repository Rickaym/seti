import { secretStateOf, type AccessKind, type SettingsSectionPath } from '@seti/shared'
import { accessCatalog } from '../agent-access.js'
import { listConnections } from '../connections.js'
import { credentialsOverview } from '../credential-profiles.js'
import { now } from '../db.js'
import { deviceInfo } from '../devices.js'
import { secrets } from '../secrets.js'
import { authEnforced } from '../seti-auth.js'
import { sshStatus } from '../ssh.js'
import { passkeyRows } from '../store/auth.js'
import { deviceRows } from '../store/devices.js'
import { permissionRules, timeoutSettings } from '../store/permissions.js'
import { setiPlugins } from '../store/plugins.js'
import { sandboxPolicy } from '../store/sandbox.js'
import { shareSettings } from '../store/shares.js'
import type { SectionReaders } from './read-agents.js'

/** Whether each item of one kind is on for a new agent, by its id. */
async function defaultsOf(kind: AccessKind): Promise<Record<string, boolean>> {
  const items = (await accessCatalog()).filter((item) => item.kind === kind)
  return Object.fromEntries(items.map((item) => [item.id, item.default_enabled]))
}

async function rules() {
  const list = await permissionRules.list(null)
  const of = (behavior: string) => list.filter((rule) => rule.behavior === behavior).map((rule) => rule.rule)
  return { allow: of('allow'), ask: of('ask'), deny: of('deny'), review: of('review') }
}

async function credentials() {
  const { profiles } = await credentialsOverview()
  const tokens = await secrets.list()
  return {
    credentials: Object.fromEntries(
      profiles.map((profile) => {
        const { role_arn, external_id, region, session_minutes } = profile.aws
        const owners = profile.github.owners.map((token) => [token.owner, secretStateOf(true)] as const)
        const credential = {
          aws: { role_arn, external_id, region, session_minutes },
          github: { default: secretStateOf(profile.github.default.configured), owners: Object.fromEntries(owners) },
          connections: profile.connections.map((connection) => connection.name),
          ssh_hosts: profile.ssh_hosts,
          access: {
            items: Object.fromEntries(
              profile.access.items.map((entry) => [`${entry.kind}:${entry.id}`, entry.enabled]),
            ),
            hosts: profile.access.hosts,
          },
        }
        return [profile.name, credential]
      }),
    ),
    agent_tokens: Object.fromEntries(tokens.map((token) => [token.name, secretStateOf(token.configured)])),
    default_access: await defaultsOf('aws'),
  }
}

/** The Capabilities and Security groups: settings and names, never a secret's value. */
export const SECURITY_READERS: SectionReaders<
  Extract<SettingsSectionPath, `capabilities.${string}` | `security.${string}`>
> = {
  'capabilities.mcp_servers': async () => ({ defaults: await defaultsOf('mcp') }),
  'capabilities.plugins': async () => ({
    folders: Object.fromEntries(
      (await setiPlugins.list()).map(({ id, name, path, enabled }) => [id, { name, path, enabled }]),
    ),
  }),
  'security.sign_in': async () => ({
    require_passkey: await authEnforced(),
    passkeys: (await passkeyRows.list()).map((passkey) => passkey.name),
    devices: (await deviceRows.list())
      .map(deviceInfo)
      .map(({ name, platform, scopes }) => ({ name, platform, scopes })),
  }),
  'security.sandbox': async () => {
    const { enabled, allowed_domains, hidden_paths } = await sandboxPolicy.get()
    return { enabled, allowed_domains, hidden_paths }
  },
  'security.permissions': async () => ({
    request_timeout_minutes: (await timeoutSettings.get()).request_timeout_minutes,
    rules: await rules(),
  }),
  'security.connections': async () => ({
    connections: Object.fromEntries(
      (await listConnections()).map(({ name, kind, env, hosts, header, mint, slots }) => [
        name,
        {
          kind,
          env,
          hosts,
          header,
          mint,
          values: Object.fromEntries(slots.map((slot) => [slot.slot, secretStateOf(slot.set)])),
        },
      ]),
    ),
  }),
  'security.credentials': credentials,
  'security.ssh': async () => {
    const { hosts, keys } = await sshStatus()
    return {
      hosts: Object.fromEntries(
        hosts.map(({ alias, hostname, port, user, key_name, jump }) => [
          alias,
          { hostname, port, user, key: key_name, jump },
        ]),
      ),
      keys: keys.map((key) => key.name),
      default_access: await defaultsOf('ssh'),
    }
  },
  'security.sharing': async () => ({ enabled: await shareSettings.enabled(now()) }),
}
