import {
  ARCHIVE_DELETE_DAYS_MAX,
  autoArchiveInput,
  isRemovableScope,
  TIER_SURFACES,
  URGENT_SURFACES,
  type McpServer,
  type Repo,
} from '@seti/shared'
import { z } from 'zod'
import { autoArchiveStatus, sweepAutoArchive, updateAutoArchive } from '../archive.js'
import { capabilityCache } from '../capabilities.js'
import { repos } from '../db.js'
import { refuseOtherAgent } from '../ea-guard.js'
import { cancelMcpSignIn, reconnectMcpServer, removeMcpServer, scopeCwd, startMcpSignIn } from '../mcp-actions.js'
import { withoutGoneServers } from '../mcp-presence.js'
import { withSignIn } from '../mcp-sign-in.js'
import { changeNotificationSettings, notificationStatus } from '../notifications.js'
import { agentPermissions, permissionPolicy } from '../permission-rules.js'
import { pluginCatalog, removeDefaultPlugin } from '../plugins.js'
import { sandboxStatus } from '../sandbox-status.js'
import { sharedToolsFor } from '../shared-tools.js'
import { sshStatus } from '../ssh.js'
import { setiPlugins } from '../store/plugins.js'
import { updateTask } from '../task-actions.js'
import { liveTask, pickOne, taskRef } from './refs.js'
import { done, setiTool, ToolRefusal } from './tool.js'

const serverRef = z.string().trim().min(1).describe('The MCP server name as list_mcp_servers shows it.')
const repoRef = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe("A registered repo's slug or id, for a server configured for that repo (local or project scope).")

const toolCount = (server: McpServer) => server.tools.length

const serverLine = (server: McpServer) => ({
  name: server.name,
  status: server.status,
  scope: server.scope,
  source: server.source,
  transport: server.transport?.type ?? null,
  tools: toolCount(server),
  sign_in: server.sign_in,
  ...(server.error === null ? {} : { error: server.error }),
})

async function repoOf(ref: string | undefined): Promise<Repo | undefined> {
  return ref === undefined ? undefined : pickOne(await repos.list(), ref, 'repo', (repo) => [repo.id, repo.slug])
}

/** The named server in the repo's scope, or the user's home scope without a repo. */
async function serverOf(name: string, ref: string | undefined) {
  const repo = await repoOf(ref)
  const snapshot = withSignIn(await capabilityCache.get(await scopeCwd(repo?.id)))
  const server = pickOne(snapshot.servers, name, 'MCP server', (s) => [s.name, s.name])
  return { server, repo }
}

const listPlugins = setiTool({
  name: 'list_plugins',
  description:
    "List Seti's default plugin folders and the Claude Code plugins installed, with what each adds, and the " +
    'shared tools: scripts agents proposed and the user allowed for every agent. Each shared tool says whether ' +
    'you have it, under which tool name, and when not, the variables your credential lacks; ask for one with ' +
    'request_change, kind api_key, and propose a script of your own with kind shared_tool.',
  input: {},
  run: async (_args, ctx) => {
    const listing = await pluginCatalog.list(false)
    return {
      shared_tools: (await sharedToolsFor(ctx.caller)).map(
        ({ name, description, needs, writes, enabled, available, missing, why, tool }) => ({
          name,
          description,
          needs,
          writes,
          enabled,
          available,
          ...(available ? { tool } : { missing, why }),
        }),
      ),
      defaults: listing.defaults.map(({ id, name, path, version, enabled, components, problem }) => ({
        id,
        name,
        path,
        version,
        enabled,
        components,
        problem,
      })),
      installed: listing.installed,
      installed_error: listing.installed_error,
    }
  },
})

const removePlugin = setiTool({
  name: 'remove_plugin',
  description: 'Remove a Seti default plugin, so new agents no longer get it; its folder stays on disk.',
  input: { plugin: z.string().trim().min(1).describe("The default plugin's id, name or folder path.") },
  run: async ({ plugin: ref }) => {
    const all = await setiPlugins.list()
    const byPath = all.find((plugin) => plugin.path === ref)
    const plugin = byPath ?? pickOne(all, ref, 'default plugin', (p) => [p.id, p.name])
    await removeDefaultPlugin(plugin.id)
    return done(`Removed the default plugin ${plugin.name}.`)
  },
})

const listMcpServers = setiTool({
  name: 'list_mcp_servers',
  description:
    'List the MCP servers agents get, with connection and sign-in state and tool counts; refresh probes them again first.',
  input: { refresh: z.boolean().default(false) },
  run: async ({ refresh }) => {
    const cwd = await scopeCwd(undefined)
    const probed = refresh ? await capabilityCache.refresh(cwd) : await capabilityCache.get(cwd)
    const snapshot = withSignIn(await withoutGoneServers(probed))
    return { probed_at: snapshot.probed_at, servers: snapshot.servers.map(serverLine) }
  },
})

const removeMcpServerTool = setiTool({
  name: 'remove_mcp_server',
  description: "Remove an MCP server from agents' configuration; agents lose its tools from their next session.",
  input: { server: serverRef, repo: repoRef },
  run: async ({ server: name, repo: ref }) => {
    const { server, repo } = await serverOf(name, ref)
    if (!isRemovableScope(server.scope)) {
      const origin = server.source ?? server.scope ?? "outside Seti's configuration"
      throw new ToolRefusal(`${server.name} comes from ${origin}, so it cannot be removed here.`)
    }
    if (server.scope !== 'user' && repo === undefined) {
      throw new ToolRefusal(`${server.name} is configured for one repo (${server.scope} scope); name the repo.`)
    }
    return removeMcpServer(server.name, server.scope, repo?.id)
  },
})

const reconnectMcpServerTool = setiTool({
  name: 'reconnect_mcp_server',
  description: "Check an MCP server's connection again and report its state and tools.",
  input: { server: serverRef, repo: repoRef },
  run: async ({ server: name, repo: ref }) => {
    const { server, repo } = await serverOf(name, ref)
    return serverLine(await reconnectMcpServer(server.name, repo?.id))
  },
})

const SIGN_IN_ELSEWHERE =
  'the user presses Sign in in Settings, MCP servers, approves in the browser and pastes back the address it returns.'

const startMcpSignInTool = setiTool({
  name: 'start_mcp_sign_in',
  description:
    'Start the sign-in of a claude.ai connector MCP server and get the link for the user to open; approving there finishes it. Other servers sign in from Settings.',
  input: { server: serverRef, repo: repoRef },
  run: async ({ server: name, repo: ref }) => {
    const { server, repo } = await serverOf(name, ref)
    if (server.status === 'connected' && server.sign_in !== 'again') {
      return done(`${server.name} is already connected; no sign-in is needed.`)
    }
    if (server.transport?.type !== 'claudeai-proxy') {
      throw new ToolRefusal(`To sign in to ${server.name}, ${SIGN_IN_ELSEWHERE}`)
    }
    const started = await startMcpSignIn(server.name, repo?.id)
    if (started.callback_expected) {
      await cancelMcpSignIn(started.session_id)
      throw new ToolRefusal(`To sign in to ${server.name}, ${SIGN_IN_ELSEWHERE}`)
    }
    return { server: server.name, authorization_url: started.authorization_url, note: 'Give the user this link.' }
  },
})

const getArchiveSettings = setiTool({
  name: 'get_archive_settings',
  description:
    'The auto-archive rule (on or off, after how many idle days), after how many days archived agents are deleted, which agents it would archive now, and what the archive holds.',
  input: {},
  run: async () => autoArchiveStatus(),
})

const setAutoArchive = setiTool({
  name: 'set_auto_archive',
  description:
    'Turn auto-archive on or off, change after how many idle days it archives complete agents, or after how many days in the archive agents are deleted with their files (0 keeps them). With resume_after_restart, also whether agents a Seti restart cut off resume on their own.',
  input: {
    enabled: autoArchiveInput.shape.enabled,
    days: autoArchiveInput.shape.days,
    delete_after_days: z
      .number()
      .int()
      .min(0)
      .max(ARCHIVE_DELETE_DAYS_MAX)
      .optional()
      .describe('Days in the archive before an agent is deleted; 0 turns deleting off.'),
    resume_after_restart: autoArchiveInput.shape.resume_after_restart.describe(
      'true to send agents a restart cut off one message to go on; false to leave them for the user.',
    ),
  },
  run: async ({ delete_after_days: deleteAfter, ...rest }) => {
    if (Object.values(rest).every((value) => value === undefined) && deleteAfter === undefined) {
      throw new ToolRefusal('Give enabled, days, delete_after_days, resume_after_restart or several.')
    }
    return updateAutoArchive({
      ...rest,
      ...(deleteAfter === undefined ? {} : { delete_after_days: deleteAfter === 0 ? null : deleteAfter }),
    })
  },
})

const runArchiveSweep = setiTool({
  name: 'run_archive_sweep',
  description:
    'Archive now every complete agent the auto-archive rule would take, even while the rule is off. Never yourself.',
  input: {},
  run: async (_input, ctx) => {
    const { preview } = await autoArchiveStatus()
    if (preview.count === 0) {
      throw new ToolRefusal('No agent is due for archiving now.')
    }
    if (preview.tasks.some((task) => task.id === ctx.caller.id)) {
      throw new ToolRefusal('The sweep would archive you; the user runs it from Settings.')
    }
    return sweepAutoArchive('user')
  },
})

const sshHosts = setiTool({
  name: 'ssh_hosts',
  description:
    'List the SSH hosts agents may reach: where each is, its jump host, the user and key name it logs in with, whether it is on by default, and which credentials bundle it. Never key material. Read only: the user changes SSH in Settings.',
  input: {},
  run: async () => ({ ...(await sshStatus()), keys: [] }),
})

const getSecuritySettings = setiTool({
  name: 'get_security_settings',
  description:
    "Read the sandbox setting, its network allowlist and hidden paths, and whether agents have a GitHub token. With rules, the permission rules instead: the user's, those from Claude Code's settings files, Seti's built-in rules, guards and review gaps, and with task that agent's own and its project's. Only the user changes these.",
  input: {
    rules: z.boolean().default(false).describe('Instead, the permission rules that decide which calls run or ask.'),
    task: taskRef.optional().describe("With rules, this agent's own rules and its project's too."),
  },
  run: async ({ rules, task: ref }) => {
    if (rules) {
      const task = ref === undefined ? undefined : await liveTask(ref)
      if (task !== undefined) {
        refuseOtherAgent(task.id)
      }
      return task === undefined ? permissionPolicy() : agentPermissions(task)
    }
    const status = await sandboxStatus()
    return {
      policy: status.policy,
      built_in_hidden: status.built_in_hidden,
      token_mode: status.token_mode,
      claude_credential: status.claude_credential,
    }
  },
})

const tierArg = (what: string) => z.enum(TIER_SURFACES).optional().describe(what)

const setNotifications = setiTool({
  name: 'set_notifications',
  description:
    "Mute or unmute one agent's notifications, or choose where each attention tier reaches the user: push (a phone push while away, a toast while a Seti page has focus, the EA call while one is live), toast (only a page with focus, else the brief), brief (only the since-you-left brief) or off. What is left out stays as it is; the answer shows the tiers.",
  input: {
    task: taskRef.optional(),
    muted: z.boolean().optional().describe('With task: true mutes its notifications, false unmutes them.'),
    urgent: z
      .enum(URGENT_SURFACES)
      .optional()
      .describe('Agents that need the user, failed turns and CI, critical alerts: push or toast only.'),
    active: tierArg('Finished turns of agents the EA does not watch, reminders, mentions and alerts.'),
    digest: tierArg("A watched agent's routine news: a finished turn, CI passed, a merge, waiting updates."),
    passive: tierArg('What only informs the EA, such as a linked PR.'),
  },
  run: async ({ task: ref, muted, ...tiers }) => {
    const change = Object.fromEntries(Object.entries(tiers).filter(([, surface]) => surface !== undefined))
    if (ref === undefined && Object.keys(change).length === 0) {
      throw new ToolRefusal('Name an agent with muted, or set urgent, active, digest or passive.')
    }
    if ((ref === undefined) !== (muted === undefined)) {
      throw new ToolRefusal('Send task and muted together to mute or unmute an agent.')
    }
    const agent = ref === undefined || muted === undefined ? null : await liveTask(ref)
    const changed =
      agent === null || muted === undefined ? null : await updateTask(agent.id, { notifications_muted: muted })
    const { settings } = await changeNotificationSettings(change)
    const devices = (await notificationStatus()).devices.length
    return {
      settings,
      devices,
      ...(changed === null
        ? {}
        : { agent: { id: changed.id, title: changed.title, muted: changed.notifications_muted } }),
    }
  },
})

export const PLATFORM_TOOLS = [
  listPlugins,
  removePlugin,
  listMcpServers,
  removeMcpServerTool,
  reconnectMcpServerTool,
  startMcpSignInTool,
  getArchiveSettings,
  setAutoArchive,
  runArchiveSweep,
  setNotifications,
  sshHosts,
  getSecuritySettings,
]
