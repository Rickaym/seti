import {
  auditQuery,
  chatSearchQuery,
  eaSearchQuery,
  formatBytes,
  importSessionInput,
  isDirect,
  recipientLabel,
  type SearchMode,
  sessionListQuery,
  TEAM_FILE_BYTES_MAX,
  TEAM_FILES_MAX,
  teamFileInput,
  teamMemberInput,
  teamPostInput,
} from '@seti/shared'
import { z } from 'zod'
import { accountStatus } from '../account.js'
import { capOf, defaultsBeyond } from '../agent-cap.js'
import { now, repos } from '../db.js'
import { liveContext } from '../ea-context.js'
import { searchIndex } from '../ea-index.js'
import { sendFiles } from '../file-handoff.js'
import { homeSummary, readerZone } from '../home.js'
import { listMods } from '../mods/actions.js'
import { themeEntries } from '../mods/themes.js'
import { resourceSampler } from '../resources.js'
import { sessionService } from '../sessions.js'
import { anyTask, liveTask, pickOne, taskRef } from './refs.js'
import { auditEvents } from '../store/audit.js'
import { eaUsage } from '../store/ea-usage.js'
import { teamSearch } from '../store/search.js'
import { teamMessages } from '../store/team.js'
import { authorLabel, postTeamMessage, updateMember } from '../team.js'
import { currentSettings } from '../user-settings.js'
import { setiTool, ToolRefusal } from './tool.js'

const TEAM_LIMIT_MAX = 100
const FIND_LIMIT = 20
const SESSION_PAGE = 20
const SESSION_SCAN = 200

const readTeamChat = setiTool({
  name: 'read_team_chat',
  description:
    'Read the Seti group chat, where the user, the EA and the agents talk; agents mention each other with @handles. Newest last. A message with `to` is a direct message only you, that member and the user see.',
  input: { limit: z.number().int().min(1).max(TEAM_LIMIT_MAX).default(30) },
  run: async ({ limit }, ctx) =>
    (await teamMessages.list({ kind: 'task', taskId: ctx.caller.id }, limit)).map((message) => ({
      id: message.id,
      author: authorLabel(message),
      ...(isDirect(message) ? { to: recipientLabel(message), direct: true } : {}),
      at: message.created_at,
      text: message.text,
    })),
})

const findInTeamChat = setiTool({
  name: 'find_in_team_chat',
  description:
    'Find group chat messages with some text, however far back, newest first, each with a line around the match and its message id.',
  input: { query: z.string().trim().min(1), whole_words: z.boolean().default(false) },
  run: async ({ query, whole_words: words }, ctx) => {
    const mode: SearchMode = words ? 'words' : 'text'
    const reader = { kind: 'task', taskId: ctx.caller.id } as const
    const found = await teamSearch.search(reader, chatSearchQuery.parse({ q: query, mode, limit: FIND_LIMIT }))
    const direct = await teamMessages.parties(found.hits.map((hit) => hit.id))
    return { ...found, hits: found.hits.map((hit) => (direct.has(hit.id) ? { ...hit, direct: true } : hit)) }
  },
})

const postTeamChat = setiTool({
  name: 'post_team_chat',
  description:
    'Post to the group chat as yourself. It reaches every active agent that is not muted at its next step; an @handle reaches that agent at once, @all also starts idle agents, @ea the EA and @user the user. ' +
    'With to, the post is a direct message instead: it reaches only that agent, or ea, at its next step, and only you, they and the user see it. Answer a direct message with to set to its author, so the answer stays private.',
  input: {
    text: teamPostInput.shape.text,
    to: teamPostInput.shape.to.describe("One recipient's @handle, or @ea, for a direct message."),
  },
  run: async ({ text, to }, ctx) => postTeamMessage({ kind: 'task', taskId: ctx.caller.id }, text, { to }),
})

const sendFile = setiTool({
  name: 'send_file',
  description:
    "Hand files to another agent: Seti copies them into its workspace at inbox/<your handle>/ and posts one group chat message that @mentions it with each file's full path, which wakes it. " +
    'With to ea, the EA gets a direct message naming each file and reads it where it is; never key, credential or env files. ' +
    `Only files in your own folders and workspace, at most ${String(TEAM_FILES_MAX)} files of ${formatBytes(TEAM_FILE_BYTES_MAX)} each.`,
  input: teamFileInput.shape,
  run: async (args, ctx) => {
    const sent = await sendFiles(ctx.caller, args, { actor: 'agent' })
    return {
      to: `@${sent.to}`,
      files: sent.files,
      message_id: sent.posted.message.id,
      deliveries: sent.posted.deliveries,
    }
  },
})

const setAgentGroupChat = setiTool({
  name: 'set_agent_group_chat',
  description: 'Mute or unmute an agent in the group chat, or change its @handle there.',
  input: { task: taskRef, ...teamMemberInput.shape },
  run: async ({ task: ref, handle, muted }) => {
    if (handle === undefined && muted === undefined) {
      throw new ToolRefusal('Pass muted, a new handle, or both.')
    }
    const task = await liveTask(ref)
    return updateMember(task.id, { handle, muted }, 'user')
  },
})

const searchAudit = setiTool({
  name: 'search_audit',
  description:
    'Search the audit log of what the user, the EA, agents and Seti did, newest first. Filter by area or kind (such as task or task.created), actor and words; page with before.',
  input: {
    area: auditQuery.shape.kind,
    actor: auditQuery.shape.actor,
    query: auditQuery.shape.q,
    limit: auditQuery.shape.limit,
    before: auditQuery.shape.before,
  },
  run: async ({ area, actor, query, limit, before }) =>
    auditEvents.page(auditQuery.parse({ kind: area, actor, q: query, limit, before })),
})

const searchSeti = setiTool({
  name: 'search_seti',
  description:
    'Search what agents, their subagents and PRs said: decisions, findings, reports, reviews and PR descriptions, with the agent or PR each excerpt came from.',
  input: { query: eaSearchQuery.shape.q, task: taskRef.optional().describe('Only this agent.') },
  run: async ({ query, task: ref }) => {
    const task = ref === undefined ? undefined : await anyTask(ref)
    return searchIndex(eaSearchQuery.parse({ q: query, task: task?.id, limit: 10 }))
  },
})

const setiOverview = setiTool({
  name: 'seti_overview',
  description:
    "A compact picture of what is going on in Seti: running and failed agents, updates waiting, the user's PRs needing attention, recent events and account limits.",
  input: {
    metrics: z
      .boolean()
      .default(false)
      .describe(
        "Instead, the shipping metrics: PRs merged in the last 7 and 30 days, the daily streak, turns, time running and cost per day, the latest merges, MCP servers per agent, and under ea the EA's own model calls over 7 days with their tokens, cached share and latency.",
      ),
    mods: z
      .boolean()
      .default(false)
      .describe(
        "Instead, Seti's mods: each with its version, whether it is on, what it does and what it may do, whether safe mode is on, and the theme with the themes on offer.",
      ),
  },
  run: async ({ metrics, mods }) => {
    if (metrics) {
      const [summary, ea] = await Promise.all([homeSummary(), eaUsage.stats(await readerZone({}), now())])
      return { ...summary, ea }
    }
    if (mods) {
      const [list, settings] = await Promise.all([listMods(), currentSettings()])
      const listed = list.mods.map(({ manifest: _manifest, icon: _icon, ...mod }) => mod)
      return { ...list, mods: listed, theme: settings.theme ?? { id: 'default' }, themes: themeEntries() }
    }
    const [context, account] = await Promise.all([liveContext(), accountStatus({ refresh: false })])
    return { as_of: context.as_of, text: context.text, account: { health: account.health, usage: account.usage } }
  },
})

const accountStatusTool = setiTool({
  name: 'account_status',
  description:
    "The Claude account Seti's agents use: the saved login in use and the other saved logins by name, login health, plan usage windows and rate limits. Only the user switches logins.",
  input: { refresh: z.boolean().default(false) },
  run: async ({ refresh }) => accountStatus({ refresh }),
})

const resourceUsage = setiTool({
  name: 'resource_usage',
  description:
    "This machine's load: CPU, memory, swap and disks, Seti's services, the agents' processes and any resource warnings.",
  input: {},
  run: async () => resourceSampler.current(),
})

const listSessions = setiTool({
  name: 'list_sessions',
  description:
    'List Claude Code sessions started from a terminal or IDE on this machine that can be imported as agents, newest first.',
  input: { query: sessionListQuery.shape.q },
  run: async ({ query }) => sessionService.list(sessionListQuery.parse({ q: query, limit: SESSION_PAGE })),
})

const importSessions = setiTool({
  name: 'import_sessions',
  description:
    'Import terminal or IDE sessions as agents, with their conversation and the PRs they opened. They get the default access, so this is refused when that reaches beyond your own.',
  input: {
    sessions: z.array(z.string().trim().min(1)).min(1).max(10).describe('Session ids or titles.'),
    repo: z.string().trim().min(1).optional().describe('Run them in this registered repo, by slug or id.'),
  },
  run: async ({ sessions, repo }, ctx) => {
    const beyond = await defaultsBeyond(await capOf(ctx.caller))
    if (beyond.length > 0) {
      throw new ToolRefusal(
        `Imported agents would get more than you have: ${beyond.join(', ')}. Ask @user to import them.`,
      )
    }
    const known = (await sessionService.list(sessionListQuery.parse({ limit: SESSION_SCAN }))).sessions
    const chosen = [...new Set(sessions.map((ref) => pickOne(known, ref, 'session', (s) => [s.id, s.title]).id))]
    const repoField =
      repo === undefined ? {} : { repo_id: pickOne(await repos.list(), repo, 'repo', (r) => [r.id, r.slug]).id }
    return sessionService.importMany(chosen.map((id) => ({ session_id: id, ...importSessionInput.parse(repoField) })))
  },
})

export const TEAM_TOOLS = [
  readTeamChat,
  findInTeamChat,
  postTeamChat,
  setAgentGroupChat,
  searchAudit,
  searchSeti,
  setiOverview,
  accountStatusTool,
  resourceUsage,
  listSessions,
  importSessions,
]

/** Team tools every agent gets at any Seti control level, like the group chat itself. */
export const HANDOFF_TOOLS = [sendFile]
