import fs from 'node:fs'
import os from 'node:os'
import { serve, type WebSocketServerLike } from '@hono/node-server'
import { WebSocketServer } from 'ws'
import { accountStatus, warmAccount } from './account.js'
import { createApp } from './app.js'
import { startAutoArchive } from './archive.js'
import { audit } from './audit.js'
import { inBackground } from './background.js'
import { startBackups } from './backup-schedule.js'
import { resumeBypass } from './bypass.js'
import { capabilityCache } from './capabilities.js'
import { startRequestExpiry } from './change-requests.js'
import { stopChannelRuns } from './channels/drain.js'
import { startRouteRetries } from './channels/router.js'
import { startLoginKeeper } from './claude-logins.js'
import {
  BACKUP,
  BACKUP_DIR,
  DATABASE_URL,
  HOST,
  PLANNER_MODULE,
  SDK_MODULE,
  PORT,
  PUBLIC_ACCESS,
  SETI_HOME,
  TASK_RETENTION_DAYS,
} from './config.js'
import { openDatabase, tasks } from './db.js'
import { followLiveContext } from './ea-context.js'
import { startInboxSweeper } from './ea-deliver.js'
import { startEaIndex } from './ea-index.js'
import { importAgentTokenFile } from './github-token.js'
import { wakeWaiting } from './inputs.js'
import { readLocalTokens } from './local-auth.js'
import { startMcpLoginKeeper } from './mcp-login-keeper.js'
import { modHost } from './mods/bundled.js'
import { watchDevMods } from './mods/dev.js'
import { startModUpdates } from './mods/updates.js'
import { notifyInterrupted, preparePush } from './notifications.js'
import { dropLeftoverRequests } from './permission-requests.js'
import { enforcePrivateHome } from './permissions.js'
import { loadPlannerModule } from './planner.js'
import { retireBundledPlugins } from './plugins.js'
import { pollerScheduler } from './pollers/service.js'
import { prDiscovery } from './pr-discovery.js'
import { prInputs } from './pr-inputs.js'
import { cache } from './redis.js'
import { reminderTicker } from './reminders/service.js'
import { resourceSampler } from './resources.js'
import { markRestartCut, resumeInterrupted } from './restart-resume.js'
import { startArchiveLifecycle, startTaskRetention } from './retention.js'
import { TERMINAL_FRAME_MAX } from './routes/terminal.js'
import { loadSdkModule } from './sdk-query.js'
import { storeBox } from './secrets.js'
import { signInHint } from './seti-auth.js'
import { stopLeftoverScopes } from './stale-scopes.js'
import { watchSilentSessions } from './stall-watch.js'
import { auditEvents } from './store/audit.js'
import { channelStore } from './store/channels.js'
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

/** Lets poller and reminder runs finish or stop them first; the signal then ends the process. */
function stopOn(signal: 'SIGTERM' | 'SIGINT'): void {
  process.once(signal, () => {
    stopTerminals()
    void stopChannelRuns().finally(() => process.kill(process.pid, signal))
  })
}

checkCredentials()
stopOn('SIGTERM')
stopOn('SIGINT')
enforcePrivateHome(SETI_HOME, BACKUP_DIR)
await openDatabase()
indexOlderMessages()
await sealLegacySecrets()
relayTaskEvents()
relayTeamEvents()
await auditEvents.sealPending()
await stopLeftoverScopes()
await dropLeftoverRequests()
await resumeBypass()
startRequestExpiry()
const interrupted = await markRestartCut()
await retireBundledPlugins()
audit.startRetention()
await pollerScheduler.start()
reminderTicker.start()
prInputs.start()
prDiscovery.start()
startBackups(DATABASE_URL, BACKUP_DIR, BACKUP)
startTaskRetention(TASK_RETENTION_DAYS)
startAutoArchive()
startArchiveLifecycle()
startMcpLoginKeeper()
startLoginKeeper()
resourceSampler.start()
startInboxSweeper()
startRouteRetries()
watchSilentSessions()
followLiveContext()
await preparePush()
await modHost.start()
await watchDevMods()
startModUpdates()
notifyInterrupted(interrupted.notify)
await startEaIndex()
if (PLANNER_MODULE !== '') {
  await loadPlannerModule(PLANNER_MODULE)
}
if (SDK_MODULE !== '') {
  await loadSdkModule(SDK_MODULE)
}

// The adapter is built for ws, but types its server narrower than ws's overloaded one.
const sockets = new WebSocketServer({
  noServer: true,
  maxPayload: TERMINAL_FRAME_MAX,
}) as unknown as WebSocketServerLike

serve({ fetch: createApp().fetch, hostname: HOST, port: PORT, websocket: { server: sockets } }, (info) => {
  process.stdout.write(`seti listening on http://${info.address}:${String(info.port)}\n`)
  void signInHint(PUBLIC_ACCESS)
  void wakeWaiting()
  inBackground('resume', async () => resumeInterrupted(interrupted.resume))
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
