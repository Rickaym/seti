import fs from 'node:fs'
import os from 'node:os'
import { serve, type WebSocketServerLike } from '@hono/node-server'
import { UPLOAD_REQUEST_MS } from '@seti/shared'
import { WebSocketServer } from 'ws'
import { accountStatus, warmAccount } from './account.js'
import { createApp } from './app.js'
import { startAutoArchive } from './archive.js'
import { rearmAskingReminders } from './asking-reminder.js'
import { audit } from './audit.js'
import { inBackground } from './background.js'
import { startBackups } from './backup-schedule.js'
import { resumeBypass } from './bypass.js'
import { capabilityCache } from './capabilities.js'
import { startRequestExpiry } from './change-requests.js'
import { stopChannelRuns } from './channels/drain.js'
import { warmFilters } from './channels/filter-actions.js'
import { startRouteRetries } from './channels/router.js'
import { startLoginKeeper } from './claude-logins.js'
import {
  BACKUP,
  BACKUP_DIR,
  DATABASE_URL,
  HOST,
  NODE_SPLIT,
  PLANNER_MODULE,
  SDK_MODULE,
  PORT,
  PUBLIC_ACCESS,
  SETI_HOME,
  TASK_RETENTION_DAYS,
} from './config.js'
import { openDatabase, sql, tasks } from './db.js'
import { cutDreamsAtStart } from './dreams/start.js'
import { followLiveContext } from './ea-context.js'
import { startInboxSweeper } from './ea-deliver.js'
import { startEaIndex } from './ea-index.js'
import { watchInterrupted } from './ea-turn-watch.js'
import { importAgentTokenFile } from './github-token.js'
import { wakeWaiting } from './inputs.js'
import { startKnowledgeSweep } from './knowledge.js'
import { readLocalTokens } from './local-auth.js'
import { startMcpLoginKeeper } from './mcp-login-keeper.js'
import { modHost } from './mods/bundled.js'
import { watchDevMods } from './mods/dev.js'
import { startModUpdates } from './mods/updates.js'
import { connectNode } from './node-split.js'
import { notifyInterrupted, preparePush } from './notifications.js'
import { resumePermissionTimeouts } from './permission-timeout.js'
import { enforcePrivateHome } from './permissions.js'
import { loadPlannerModule } from './planner.js'
import { retireBundledPlugins } from './plugins.js'
import { pollerScheduler } from './pollers/service.js'
import { prDiscovery } from './pr-discovery.js'
import { prInputs } from './pr-inputs.js'
import { warmOpenPrs } from './prs.js'
import { cache } from './redis.js'
import { reminderTicker } from './reminders/service.js'
import { resourceSampler } from './resources.js'
import { cutRunningTurns } from './restart-cut.js'
import { markRestartCut, resumeInterrupted } from './restart-resume.js'
import { keepLeftoverRequests } from './restart-waits.js'
import { startArchiveLifecycle, startTaskRetention } from './retention.js'
import { TERMINAL_FRAME_MAX } from './routes/terminal.js'
import { loadSdkModule } from './runtimes/registry.js'
import { storeBox } from './secrets.js'
import { signInHint } from './seti-auth.js'
import { syncSharedTools } from './shared-tools.js'
import { stopLeftoverScopes } from './stale-scopes.js'
import { watchSilentSessions } from './stall-watch.js'
import { startStorageSchedule } from './storage-schedule.js'
import { auditEvents } from './store/audit.js'
import { channelStore } from './store/channels.js'
import { fillEventColumns } from './store/event-columns.js'
import { backfillMessageSearch } from './store/search.js'
import { relayTaskEvents } from './task-events.js'
import { relayTeamEvents } from './team-events.js'
import { stopTerminals } from './terminal.js'

const CAPABILITY_REFRESH_MS = 15 * 60 * 1000
const ACCOUNT_REFRESH_MS = 5 * 60 * 1000

function refreshCapabilities(): void {
  capabilityCache.refresh(os.homedir()).catch((e: unknown) => {
    process.stderr.write(`capability probe failed: ${e instanceof Error ? e.message : String(e)}\n`)
  })
}

const refreshAccount = () => void accountStatus({ refresh: true })

/** A result younger than this, from any process or an earlier run, stands in for a new probe. */
const FRESH_SLACK_MS = 60_000
const PROBE_CLAIM_MS = 60_000

/** Each interval one process probes; the others, and a restart, take its result from Redis. */
async function probeOnce(key: string, warm: () => Promise<boolean>, probe: () => void): Promise<void> {
  if (!(await warm()) && (await cache.claim(key, PROBE_CLAIM_MS))) {
    probe()
  }
}

const capabilities = async () =>
  probeOnce(
    'probe:capabilities',
    async () => capabilityCache.warm(os.homedir(), CAPABILITY_REFRESH_MS - FRESH_SLACK_MS),
    refreshCapabilities,
  )
/** Probes the directories of agents that are not archived, so their first "/" answers at once. */
async function warmTaskDirs(): Promise<void> {
  const cwds = new Set((await tasks.list()).map((task) => task.cwd))
  capabilityCache.startWarming([...cwds].filter((cwd) => fs.existsSync(cwd)))
}

const account = async () =>
  probeOnce('probe:account', async () => warmAccount(ACCOUNT_REFRESH_MS - FRESH_SLACK_MS), refreshAccount)

/** Checks the credentials before anything else, so a missing key stops Seti with its reason. */
function checkCredentials(): void {
  storeBox()
  const tokens = readLocalTokens()
  if (tokens.user === null || tokens.ea === null) {
    const missing = [tokens.user === null ? 'local-token-user' : '', tokens.ea === null ? 'local-token-ea' : '']
    process.stderr.write(
      `key files: no usable ${missing.filter((name) => name !== '').join(' or ')}; ` +
        'local callers without one are refused\n',
    )
  }
}

/** Moves secrets older versions kept in the clear into the store. */
async function sealLegacySecrets(): Promise<void> {
  const sealed = await channelStore.sealLegacySecrets()
  if (sealed > 0) {
    process.stderr.write(`secrets: sealed ${String(sealed)} webhook secrets stored in the clear\n`)
  }
  await importAgentTokenFile()
}

/** Indexes transcripts written before search existed, without holding up startup. */
function indexOlderMessages(): void {
  backfillMessageSearch()
    .then((batches) => {
      if (batches > 0) {
        process.stdout.write(`search: indexed older messages in ${String(batches)} batches\n`)
      }
    })
    .catch((e: unknown) => {
      process.stderr.write(`search: indexing older messages failed: ${e instanceof Error ? e.message : String(e)}\n`)
    })
}

/** Fills the event columns of transcript rows stored before them, without holding up startup. */
function fillOlderRows(): void {
  const started = performance.now()
  const minutes = () => ((performance.now() - started) / 60_000).toFixed(1)
  const onProgress = (rows: number) => {
    process.stdout.write(`events: filling older messages, ${String(rows)} so far after ${minutes()} min\n`)
  }
  fillEventColumns(sql, { onProgress })
    .then((rows) => {
      if (rows > 0) {
        process.stdout.write(`events: filled the event columns of ${String(rows)} older messages in ${minutes()} min\n`)
      }
    })
    .catch((e: unknown) => {
      process.stderr.write(`events: filling older messages failed: ${e instanceof Error ? e.message : String(e)}\n`)
    })
}

/** Records and ends the running turns, for the next start to resume; a failure only logs. */
async function cutTurns(): Promise<void> {
  try {
    await cutRunningTurns()
  } catch (e) {
    process.stderr.write(`stop: could not record the running turns: ${e instanceof Error ? e.message : String(e)}\n`)
  }
}

/**
 * Lets poller and reminder runs finish or stops them, and records and ends the running turns
 * meanwhile; the signal then ends the process.
 */
function stopOn(signal: 'SIGTERM' | 'SIGINT'): void {
  process.once(signal, () => {
    stopTerminals()
    const turns = NODE_SPLIT ? Promise.resolve() : cutTurns()
    void Promise.all([stopChannelRuns(), turns]).finally(() => process.kill(process.pid, signal))
  })
}

checkCredentials()
stopOn('SIGTERM')
stopOn('SIGINT')
enforcePrivateHome(SETI_HOME, BACKUP_DIR)
await openDatabase()
indexOlderMessages()
fillOlderRows()
await sealLegacySecrets()
relayTaskEvents()
relayTeamEvents()
await auditEvents.sealPending()
await stopLeftoverScopes()
if (!NODE_SPLIT) {
  await keepLeftoverRequests()
}
await resumeBypass()
startRequestExpiry()
startKnowledgeSweep()
// A separate node keeps its turns across this restart and reports any it lost as it connects.
const interrupted = NODE_SPLIT ? { notify: [], resume: [] } : await markRestartCut()
await cutDreamsAtStart()
await retireBundledPlugins()
await syncSharedTools()
audit.startRetention()
await pollerScheduler.start()
reminderTicker.start()
prInputs.start()
warmOpenPrs()
prDiscovery.start()
startBackups(DATABASE_URL, BACKUP_DIR, BACKUP)
startTaskRetention(TASK_RETENTION_DAYS)
startAutoArchive()
startArchiveLifecycle()
startStorageSchedule()
startMcpLoginKeeper()
startLoginKeeper()
resourceSampler.start()
startInboxSweeper()
startRouteRetries()
warmFilters()
watchSilentSessions()
followLiveContext()
await preparePush()
await modHost.start()
await watchDevMods()
startModUpdates()
notifyInterrupted(interrupted.notify)
watchInterrupted(interrupted.notify)
await rearmAskingReminders()
await startEaIndex()
if (PLANNER_MODULE !== '') {
  await loadPlannerModule(PLANNER_MODULE)
}
if (SDK_MODULE !== '') {
  await loadSdkModule(SDK_MODULE)
}
if (NODE_SPLIT) {
  await connectNode()
}

// The adapter is built for ws, but types its server narrower than ws's overloaded one.
const sockets = new WebSocketServer({
  noServer: true,
  maxPayload: TERMINAL_FRAME_MAX,
}) as unknown as WebSocketServerLike

const listen = {
  fetch: createApp().fetch,
  hostname: HOST,
  port: PORT,
  websocket: { server: sockets },
  serverOptions: { requestTimeout: UPLOAD_REQUEST_MS },
}

serve(listen, (info) => {
  process.stdout.write(`seti listening on http://${info.address}:${String(info.port)}\n`)
  void signInHint(PUBLIC_ACCESS)
  void wakeWaiting(interrupted.resume.map((each) => each.taskId))
  inBackground('resume', async () => resumeInterrupted(interrupted.resume))
  inBackground('permission timeouts', resumePermissionTimeouts)
  void audit.record({
    actor: 'system',
    kind: 'system.started',
    subject_type: 'system',
    summary: `Seti started on ${info.address}:${String(info.port)}`,
    detail: { pid: process.pid, node: process.version },
  })
  void capabilities()
  setInterval(() => void capabilities(), CAPABILITY_REFRESH_MS)
  void warmTaskDirs()
  void account()
  setInterval(() => void account(), ACCOUNT_REFRESH_MS)
})
