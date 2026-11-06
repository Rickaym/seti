import { summarizeCapabilities, type CapabilitiesSnapshot, type CommandInfo } from '@seti/shared'
import { Hono } from 'hono'
import { commandCatalog } from '../commands.js'
import type { PublicAccess } from '../config.js'
import { ok } from '../http.js'
import { securityHeaders } from '../security-headers.js'

const command = (name: string, description: string): CommandInfo => ({
  name,
  description,
  argument_hint: '',
  aliases: [],
})

/** What a probe of Claude Code would report, fixed, since the demo never starts Claude Code. */
function snapshot(): CapabilitiesSnapshot {
  return {
    cwd: '',
    probed_at: new Date().toISOString(),
    duration_ms: 0,
    pending_timed_out: false,
    account: { email: null, organization: 'Acme', subscription_type: 'max', api_provider: 'firstParty' },
    servers: [],
    skill_groups: [{ prefix: null, commands: [command('review', 'Review the changes on this branch')] }],
    builtin_commands: [
      command('compact', 'Summarise the conversation to free context'),
      command('clear', 'Start a fresh conversation'),
    ],
    subagents: [],
    models: [{ value: 'default', display_name: 'Default', description: 'The recommended model' }],
  }
}

/**
 * Answers the capability reads with a fixed snapshot ahead of Seti's own routes, which would
 * start Claude Code to probe. The answer is the same for everyone and holds nothing of anyone's.
 */
export function demoCapabilityRoutes(access: PublicAccess | null): Hono {
  const headers = securityHeaders(access)
  return new Hono()
    .get('/api/capabilities', headers, (c) => ok(c, snapshot()))
    .get('/api/capabilities/summary', headers, (c) => ok(c, summarizeCapabilities(snapshot())))
    .get('/api/tasks/:id/commands', headers, (c) =>
      ok(c, commandCatalog({ snapshot: snapshot(), exact: true, fresh: true })),
    )
}
