import fs from 'node:fs'
import path from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import {
  ASSET_LINKS_PATH,
  DEVICE_PAIR_PATH,
  PAIR_PAGE_PATH,
  SETI_HOSTNAMES,
  WIDGET_SUMMARY_PATH,
  type DeviceScope,
  type SystemInfo,
} from '@seti/shared'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  accessGuard,
  createAccessVerifier,
  currentPublicHost,
  currentRequestSource,
  isOpenPath,
  isSameOrigin,
  onProofRefused,
  type AccessGuardOptions,
} from './access.js'
import { cancelWaitsOnArchive, deliverAgentWaits } from './agent-waits.js'
import { briefOnReturn } from './attention-brief.js'
import { inBackground } from './background.js'
import { setAfterProbe, setProbePlugins } from './capabilities.js'
import { compressEventStreams } from './compress-events.js'
import { EA_URL, PERMISSION_MODE, PUBLIC_ACCESS, UI_DIST } from './config.js'
import { connectionContext } from './connection-egress.js'
import { cpuPrompt } from './cpu-cap.js'
import { assetLinks } from './devices.js'
import { watchDroppedPrompts } from './dropped-prompt.js'
import { watchBlocked, watchTurnEnd } from './ea-turn-watch.js'
import { jsonEtag } from './etag.js'
import { githubTokenMode } from './github-token.js'
import { fail, HttpError, ok } from './http.js'
import { inputPreface, wakeAfterTurn } from './inputs.js'
import { knowledgeContext } from './knowledge-index.js'
import { defaultLocalAuth } from './local-auth.js'
import { forgetGoneServersLater } from './mcp-presence.js'
import { memoryPrompt } from './memory-cap.js'
import { recordMemoryEvents } from './memory-notes.js'
import { connectModLogic } from './mods/logic/service.js'
import { modLogicHost } from './mods/logic-host.js'
import { modContextPrompt } from './mods/ops/context.js'
import { logicOps } from './mods/ops/table.js'
import { startModTaskEvents } from './mods/task-events.js'
import { notifyStatusEvent, notifyTurnEnd } from './notifications.js'
import { PAIR_PAGE } from './pair-page.js'
import { defaultPluginConfigs } from './plugins.js'
import { prDiscovery } from './pr-discovery.js'
import { stoppedPreface } from './process-stop.js'
import { accessRoutes } from './routes/access.js'
import { accountRoutes } from './routes/account.js'
import { archivedGuard, archiveRoutes, taskArchiveRoutes } from './routes/archive.js'
import { attentionRoutes } from './routes/attention.js'
import { auditRoutes } from './routes/audit.js'
import { authRoutes } from './routes/auth.js'
import { capabilityRoutes } from './routes/capabilities.js'
import { changeRequestRoutes } from './routes/change-requests.js'
import { channelRoutes, eaChannelRoutes, taskChannelRoutes } from './routes/channels.js'
import { compactRoutes, taskCompactRoutes } from './routes/compact.js'
import { commandRoutes, taskComposerRoutes } from './routes/composer.js'
import { connectionRoutes } from './routes/connections.js'
import { contextRoutes, eaContextPackRoutes, taskContextRoutes } from './routes/context.js'
import { credentialRoutes, profileSummaryRoutes } from './routes/credentials.js'
import { auditRefusedProof, deviceRoutes } from './routes/devices.js'
import { eaContextRoutes } from './routes/ea-context.js'
import { eaReplyRoutes } from './routes/ea-replies.js'
import { eaStateRoutes } from './routes/ea-state.js'
import { eaUsageRoutes } from './routes/ea-usage.js'
import { eaRoutes } from './routes/ea.js'
import { taskFileRoutes, workspaceFileRoutes } from './routes/files.js'
import { historyRoutes } from './routes/history.js'
import { homeRoutes } from './routes/home.js'
import { hookRoutes } from './routes/hooks.js'
import { eaInboxRoutes } from './routes/inbox.js'
import { knowledgeRoutes } from './routes/knowledge.js'
import { localSessionRoutes } from './routes/local-session.js'
import { mcpRoutes } from './routes/mcp.js'
import { modAdminRoutes } from './routes/mod-admin.js'
import { modAskRoutes } from './routes/mod-asks.js'
import { modFrameRoutes } from './routes/mod-frames.js'
import { modLiveRoutes } from './routes/mod-live.js'
import { modRoutes } from './routes/mods.js'
import { notificationRoutes } from './routes/notifications.js'
import { permissionRoutes, taskPermissionRoutes } from './routes/permissions.js'
import { pluginRoutes } from './routes/plugins.js'
import { taskProcessRoutes } from './routes/processes.js'
import { prRoutes } from './routes/prs.js'
import { repoRoutes } from './routes/repos.js'
import { resourceRoutes } from './routes/resources.js'
import { revisionRoutes } from './routes/revisions.js'
import { sandboxRoutes } from './routes/sandbox.js'
import { secretRoutes } from './routes/secrets.js'
import { sessionRoutes } from './routes/sessions.js'
import { publicShareHandler } from './routes/share-public.js'
import { shareRoutes, taskShareRoutes } from './routes/shares.js'
import { sshRoutes } from './routes/ssh.js'
import { stepUpRoutes } from './routes/step-up.js'
import { taskRoutes } from './routes/tasks.js'
import { teamRoutes } from './routes/team.js'
import { terminalRoutes } from './routes/terminal.js'
import { uploadRoutes } from './routes/uploads.js'
import { userRoutes } from './routes/user.js'
import { widgetRoutes } from './routes/widget.js'
import { workspaceRoutes } from './routes/workspaces.js'
import { onTurnEnd, registerContextProvider, registerSessionMcpServers, registerTurnPreface } from './runner.js'
import { sandboxPrompt } from './sandbox-prompt.js'
import { securityHeaders } from './security-headers.js'
import { onSessionOpen } from './session-hooks.js'
import { restartPreface } from './session-restart.js'
import { importedContext } from './sessions.js'
import { setiControlPreface } from './seti-control-note.js'
import { contextPackPrompt, workspaceContext } from './seti-guide.js'
import { sessionSetiServers, setiToolsContext } from './seti-tools/server.js'
import { shellPreface } from './shell-context.js'
import { restartQuietOnAnswer } from './stall-watch.js'
import { clearStatusLinesWhenIdle, statusLineTurnEnded } from './status-line.js'
import { installedMods } from './store/mod-installed.js'
import { sandboxPolicy } from './store/sandbox.js'
import { subdomainProxy } from './subdomain-proxy.js'
import { clearStallsOnTurnStart } from './task-blocked.js'
import { onAnyTaskEvent } from './task-events.js'
import { taskReposContext } from './tasks.js'
import { openWorkspace, startWorkspaceSync, workspaceTurnEnded } from './workspace/engine.js'

/** Large enough for a full context file or prompt, small enough to refuse memory floods. */
export const API_BODY_MAX = 8 * 1024 * 1024

const jsonBodyLimit = bodyLimit({
  maxSize: API_BODY_MAX,
  onError: (c) => fail(c, 413, 'Request too large', 'Request bodies are limited to 8 MB'),
})

/** Uploads stream to disk under their own cap; every other body is JSON. */
const UPLOADS_PATH = '/api/uploads'

const isUpload = (c: Context) => c.req.method === 'POST' && c.req.path === UPLOADS_PATH

const apiBodyLimit: MiddlewareHandler = async (c, next) => (isUpload(c) ? next() : jsonBodyLimit(c, next))

/** The health check and the local sign-in answer loopback requests that carry no token. */
const OPEN_PATHS = new Set(['/api/ping', '/api/local-session'])

const signInHint = () =>
  currentPublicHost() === null
    ? 'Local requests need the local token or a passkey: sign in, or send Authorization: Bearer'
    : 'Sign in to Seti with a passkey'

/**
 * Cookies ride along on their own, so writes they authenticate must name Seti's page as origin.
 * Pairing sets no cookie and comes from the app, which sends none.
 */
const needsOrigin = (requestPath: string) => {
  const source = currentRequestSource()
  return source === null ? requestPath !== DEVICE_PAIR_PATH : source.via === 'session'
}

/** The routes each device scope reaches; a device reaches nothing else. */
const DEVICE_ROUTES: Record<DeviceScope, readonly string[]> = { widget: [`GET ${WIDGET_SUMMARY_PATH}`] }

const deviceRefused = (c: Context) => {
  const source = currentRequestSource()
  const route = `${c.req.method} ${c.req.path}`
  return source?.via === 'device' && !source.scopes.some((scope) => DEVICE_ROUTES[scope].includes(route))
}

/**
 * Loopback or the public Host, a local token, passkey session or Access identity, and
 * same-origin JSON writes, so neither a web page nor another local process can drive the API.
 */
const localOnly: MiddlewareHandler = async (c, next) => {
  const hostname = (c.req.header('host') ?? '').replace(/:\d+$/, '')
  if (currentPublicHost() === null && !SETI_HOSTNAMES.has(hostname)) {
    return fail(c, 403, 'Forbidden', 'Unexpected Host header')
  }
  if (currentRequestSource() === null && !OPEN_PATHS.has(c.req.path) && !isOpenPath(c.req.path)) {
    return fail(c, 401, 'Sign in', signInHint())
  }
  if (deviceRefused(c)) {
    return fail(c, 403, 'Forbidden', 'A paired device reaches only its widget summary')
  }
  if (c.req.method !== 'GET') {
    const origin = c.req.header('origin')
    if (origin === undefined ? needsOrigin(c.req.path) : !isSameOrigin(origin)) {
      return fail(c, 403, 'Forbidden', 'Cross-origin request')
    }
    const type = c.req.header('content-type') ?? ''
    const expected = isUpload(c) ? 'application/octet-stream' : 'application/json'
    if (c.req.method !== 'DELETE' && !type.startsWith(expected)) {
      return fail(c, 415, 'Unsupported media type', `Send ${expected}`)
    }
  }
  await next()
  return undefined
}

/** The API paths a page may load into a frame: an HTML preview and a mod's sandboxed pages. */
const FRAMEABLE = [/^\/api\/tasks\/[^/]+\/files\/raw$/, /^\/api\/mod-frames\/[^/]+\/(?:views|viewers)\/[^/]+$/]

/** A framed page that navigates itself to Seti's API gets no JSON, only pages meant for frames. */
const framedApiGuard: MiddlewareHandler = async (c, next) => {
  const dest = c.req.header('sec-fetch-dest')
  if ((dest === 'iframe' || dest === 'frame') && !FRAMEABLE.some((pattern) => pattern.test(c.req.path))) {
    return fail(c, 403, 'Forbidden', 'Seti does not load its API into frames')
  }
  await next()
  return undefined
}

const REVALIDATED = new Set(['/manifest.webmanifest', '/sw.js'])

/** The shell, manifest and service worker revalidate on every load; hashed assets never change. */
const cacheHeaders: MiddlewareHandler = async (c, next) => {
  await next()
  const html = c.res.headers.get('content-type')?.startsWith('text/html') === true
  if (html || REVALIDATED.has(c.req.path)) {
    c.res.headers.set('Cache-Control', 'no-cache')
  } else if (c.req.path.startsWith('/assets/') && c.res.status === 200) {
    c.res.headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  }
}

const defaultAccess = (): AccessGuardOptions => ({
  access: PUBLIC_ACCESS,
  verify: PUBLIC_ACCESS?.cloudflare ? createAccessVerifier(PUBLIC_ACCESS.cloudflare) : null,
})

export function createApp(access: AccessGuardOptions = defaultAccess(), eaUrl: string = EA_URL): Hono {
  const local = access.local ?? defaultLocalAuth()
  const app = new Hono()
  app.onError((e, c) =>
    e instanceof HttpError ? fail(c, e.status, e.message) : fail(c, 500, 'Server error', e.message),
  )
  app.use('*', securityHeaders(access.access))
  onProofRefused(auditRefusedProof)
  app.use('*', accessGuard({ ...access, local }))
  app.route('/hooks', hookRoutes)
  app.use('*', subdomainProxy)
  const publicShares = publicShareHandler(access.access)
  app.all('/share', publicShares)
  app.all('/share/*', publicShares)
  app.use('/api/*', localOnly)
  app.use('/api/*', framedApiGuard)
  app.use('/api/*', apiBodyLimit)
  app.use('/api/*', compressEventStreams)
  app.use('/api/*', jsonEtag)
  app.get('/api/ping', (c) => c.body(null, 204))
  app.get('/api/system', async (c) => {
    const sandbox = { enabled: (await sandboxPolicy.get()).enabled, token_mode: await githubTokenMode() }
    return ok(c, { permission_mode: PERMISSION_MODE, sandbox } satisfies SystemInfo)
  })
  app.use('/api/tasks/:id', archivedGuard)
  app.use('/api/tasks/:id/*', archivedGuard)
  app.route('/api/access', accessRoutes)
  app.route('/api/account', accountRoutes)
  app.route('/api/archive', archiveRoutes)
  app.route('/api/audit', auditRoutes)
  app.route('/api/connections', connectionRoutes)
  app.route('/api/credentials', credentialRoutes)
  app.route('/api/credential-profiles', profileSummaryRoutes)
  app.route('/api/capabilities', capabilityRoutes)
  app.route('/api/channels', channelRoutes)
  app.route('/api/mcp', mcpRoutes)
  app.route('/api/mod-admin', modAdminRoutes)
  app.route('/api/mods', modRoutes)
  app.route('/api/mod-asks', modAskRoutes)
  app.route('/api/mod-frames', modFrameRoutes)
  app.route('/api/mod-live', modLiveRoutes)
  app.route('/api/plugins', pluginRoutes)
  app.route('/api/prs', prRoutes)
  app.route('/api/repos', repoRoutes)
  app.route('/api/resources', resourceRoutes)
  app.route('/api/tasks', taskArchiveRoutes)
  app.route('/api/tasks', taskRoutes)
  app.route('/api/tasks', taskFileRoutes)
  app.route('/api/tasks', taskProcessRoutes)
  app.route('/api/tasks', taskCompactRoutes)
  app.route('/api/tasks', taskShareRoutes(access.access))
  app.route('/api/shares', shareRoutes(access.access))
  app.route('/api/terminals', terminalRoutes)
  app.route('/api/team', teamRoutes)
  app.route('/api/files', workspaceFileRoutes)
  app.route('/api/history', historyRoutes)
  app.route('/api/home', homeRoutes)
  app.route('/api/tasks', taskContextRoutes)
  app.route('/api/tasks', taskChannelRoutes)
  app.route('/api/tasks', taskComposerRoutes)
  app.route('/api/tasks', taskPermissionRoutes)
  app.route('/api/tasks', changeRequestRoutes)
  app.route('/api/commands', commandRoutes)
  app.route('/api/compact', compactRoutes)
  app.route('/api/context', contextRoutes)
  app.route('/api/knowledge', knowledgeRoutes)
  app.route('/api/ea', eaStateRoutes)
  app.route('/api/ea', eaUsageRoutes)
  app.route('/api/ea', eaChannelRoutes)
  app.route('/api/ea', eaContextPackRoutes)
  app.route('/api/ea', eaContextRoutes)
  app.route('/api/ea', eaInboxRoutes)
  app.route('/api/ea', eaReplyRoutes)
  app.route('/api/ea', eaRoutes(eaUrl))
  app.route('/api/local-session', localSessionRoutes(local))
  app.route('/api/auth/step-up', stepUpRoutes)
  app.route('/api/auth', authRoutes(access.access))
  app.route('/api/devices', deviceRoutes(access.access))
  app.route('/api/widget', widgetRoutes)
  app.route('/api/sandbox', sandboxRoutes)
  app.route('/api/secrets', secretRoutes)
  app.route('/api/sessions', sessionRoutes)
  app.route('/api/ssh', sshRoutes)
  app.route('/api/revisions', revisionRoutes)
  app.route('/api/uploads', uploadRoutes)
  app.route('/api/user', userRoutes)
  app.route('/api/workspaces', workspaceRoutes)
  app.route('/api/notifications', notificationRoutes)
  app.route('/api/attention', attentionRoutes)
  app.route('/api/permissions', permissionRoutes)
  registerContextProvider(workspaceContext)
  registerContextProvider(contextPackPrompt)
  registerContextProvider(taskReposContext)
  registerContextProvider(importedContext)
  setProbePlugins(defaultPluginConfigs)
  setAfterProbe(forgetGoneServersLater)
  registerContextProvider(sandboxPrompt)
  registerContextProvider(connectionContext)
  registerContextProvider(memoryPrompt)
  registerContextProvider(cpuPrompt)
  registerContextProvider(setiToolsContext)
  registerContextProvider(knowledgeContext)
  registerContextProvider(modContextPrompt)
  connectModLogic({ ops: logicOps(installedMods.manifest), host: modLogicHost })
  startModTaskEvents()
  registerSessionMcpServers(sessionSetiServers)
  onSessionOpen(openWorkspace)
  startWorkspaceSync()
  registerTurnPreface(shellPreface)
  registerTurnPreface(inputPreface)
  registerTurnPreface(stoppedPreface)
  registerTurnPreface(restartPreface)
  registerTurnPreface(setiControlPreface)
  onTurnEnd(watchTurnEnd)
  onTurnEnd(wakeAfterTurn)
  onTurnEnd((taskId) => {
    inBackground('pr discovery', async () => prDiscovery.run(taskId))
  })
  onTurnEnd(workspaceTurnEnded)
  onTurnEnd(watchDroppedPrompts)
  onTurnEnd(notifyTurnEnd)
  briefOnReturn()
  onAnyTaskEvent(notifyStatusEvent)
  onAnyTaskEvent(watchBlocked)
  onTurnEnd(statusLineTurnEnded)
  clearStallsOnTurnStart()
  restartQuietOnAnswer()
  clearStatusLinesWhenIdle()
  onTurnEnd(deliverAgentWaits)
  cancelWaitsOnArchive()
  recordMemoryEvents()
  app.all('/api/*', (c) => fail(c, 404, 'Not found'))

  app.get(ASSET_LINKS_PATH, async (c) => c.json(await assetLinks()))
  app.get(PAIR_PAGE_PATH, (c) => c.html(PAIR_PAGE))
  app.get('/agent/:id', (c) => c.redirect(`/#agents/${encodeURIComponent(c.req.param('id'))}`))
  app.use('/*', cacheHeaders)
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), UI_DIST) }))
  app.get('/*', (c) => {
    const index = path.join(UI_DIST, 'index.html')
    if (!fs.existsSync(index)) {
      return c.text('UI not built. Run: pnpm build', 503)
    }
    return c.html(fs.readFileSync(index, 'utf8'))
  })
  return app
}
