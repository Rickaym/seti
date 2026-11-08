import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type {
  createShareInput,
  FileShare,
  Share,
  ShareDiagramInput,
  ShareLink,
  ShareList,
  ShareScanRefusal,
} from '@seti/shared'
import type { z } from 'zod'
import { audit } from './audit.js'
import { now } from './db.js'
import { refuseAgent } from './ea-guard.js'
import { HttpError } from './http.js'
import { sandboxContext } from './session-options.js'
import { takeSnapshot, type Snapshot } from './share-files.js'
import { sizeLabel } from './share-page.js'
import { renderCard } from './share-preview/card.js'
import { renderPreview } from './share-preview/render.js'
import { sandboxPolicy } from './store/sandbox.js'
import { shareRows, shareSettings, type RecentViews, type ShareContent, type ShareListRow } from './store/shares.js'
import { fileRules, taskRoots, type FileContext } from './task-files.js'
import { requireTask } from './tasks.js'

const DAY_MS = 86_400_000

const WHAT = 'share files outside Seti'

/** A share's token: 32 random bytes, base64url; Seti stores only its hash. */
const newToken = () => randomBytes(32).toString('base64url')

export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')

/** Refused with the secret scan's findings; the caller may share anyway by allowing them. */
export class ShareScanError extends Error {
  readonly body: ShareScanRefusal

  constructor(snapshot: Snapshot) {
    const lines = [...new Set(snapshot.findings.map((finding) => finding.line))]
    const detail = `${snapshot.rel} looks like it holds secrets on line ${lines.join(', ')}`
    super(detail)
    this.body = { error: { title: 'Secrets found', detail }, findings: snapshot.findings }
  }
}

let enabledCache: boolean | null = null

/** Whether the Sharing switch in Settings is on; it starts off. */
export async function sharingEnabled(): Promise<boolean> {
  enabledCache ??= await shareSettings.enabled(now())
  return enabledCache
}

export async function setSharing(enabled: boolean): Promise<void> {
  refuseAgent('change sharing')
  await shareSettings.set(enabled, now())
  enabledCache = enabled
  await audit.record({
    actor: 'user',
    kind: 'system.sharing_changed',
    subject_type: 'system',
    summary: enabled ? 'Turned on public share links' : 'Turned off public share links',
    detail: { enabled },
  })
}

async function requireSharing(): Promise<void> {
  refuseAgent(WHAT)
  if (!(await sharingEnabled())) {
    throw new HttpError(403, 'Sharing is off; turn it on in Settings, Sharing')
  }
}

async function fileContext(taskId: string): Promise<FileContext> {
  const task = await requireTask(taskId)
  const rules = fileRules(task.id, await sandboxPolicy.get(), sandboxContext())
  return { task, rules, roots: taskRoots(task, rules) }
}

const NO_VIEWS: RecentViews = { views: [], unfurls: [] }

function toShare(row: ShareListRow, recent: RecentViews = NO_VIEWS): Share {
  return {
    id: row.id,
    task_id: row.task_id,
    task_title: row.task_title,
    root: row.root,
    path: row.path,
    name: row.name,
    kind: row.kind,
    size: row.size,
    assets: row.assets,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    scan_override: row.scan_override,
    view_count: row.view_count,
    recent_views: recent.views,
    link_preview: row.link_preview,
    unfurl_count: row.unfurl_count,
    recent_unfurls: recent.unfurls,
    preview: {
      label: row.preview_label ?? '',
      note: row.preview_note,
      error: row.preview_error,
      images: row.images,
      card: row.card,
    },
  }
}

async function shareOf(id: string): Promise<Share> {
  const row = await shareRows.get(id)
  if (row === undefined) {
    throw new HttpError(404, 'No such share')
  }
  return toShare(row, (await shareRows.recentViews([id])).get(id))
}

/** A thumbnail larger than this is left off the link card rather than decoded for it. */
const THUMB_MAX = 4 * 1024 * 1024

/** Renders the page, its images and the link card, once, for the share tables to serve. */
async function renderShare(snapshot: Snapshot, diagrams: readonly ShareDiagramInput[]): Promise<ShareContent> {
  const preview = await renderPreview({ ...snapshot, diagrams })
  const thumb = preview.thumb !== null && preview.thumb.bytes.length <= THUMB_MAX ? preview.thumb : null
  const card = await renderCard({
    name: snapshot.name,
    detail: `${preview.label}, ${sizeLabel(snapshot.content.length)}`,
    thumb,
    play: snapshot.kind === 'video' && thumb !== null,
  })
  if (typeof card === 'string') {
    process.stderr.write(`share: no link card for ${snapshot.rel}: ${card}\n`)
  }
  return {
    content: snapshot.content,
    sha256: snapshot.sha256,
    page: preview.body,
    assets: snapshot.assets,
    images: preview.images.map((image) => ({ mime: image.mime, bytes: image.bytes })),
    image_key: preview.imageKey,
    preview_label: preview.label,
    preview_note: preview.note,
    preview_error: preview.error,
    card: typeof card === 'string' ? null : card,
  }
}

const linkOf = (origin: string, token: string) => `${origin}/share/${token}`

const checked = (snapshot: Snapshot, allowFindings: boolean) => {
  if (snapshot.findings.length > 0 && !allowFindings) {
    throw new ShareScanError(snapshot)
  }
  return snapshot.findings.length > 0
}

const isOpen = (row: ShareListRow, at: string) => row.revoked_at === null && row.expires_at > at

async function openShare(id: string): Promise<ShareListRow> {
  const row = await shareRows.get(id)
  if (row === undefined || !isOpen(row, now())) {
    throw new HttpError(404, 'This share has ended; share the file again')
  }
  return row
}

const shareDetail = (row: Pick<ShareListRow, 'id' | 'root' | 'path' | 'task_title'>) => ({
  share: row.id,
  title: row.task_title,
  root: row.root,
  path: row.path,
})

/** Snapshots a file and opens a link to it; the link comes back once and is never stored. */
export async function createShare(
  taskId: string,
  input: z.output<typeof createShareInput>,
  origin: string,
): Promise<ShareLink> {
  await requireSharing()
  const files = await fileContext(taskId)
  const at = now()
  await shareRows.purgeExpired(at)
  const snapshot = takeSnapshot(files, input.root, input.path)
  if ((await shareRows.openFor(taskId, input.root, snapshot.rel, at)) !== undefined) {
    throw new HttpError(409, `${snapshot.rel} is already shared; update it or make a new link`)
  }
  const override = checked(snapshot, input.allow_findings)
  const body = await renderShare(snapshot, input.diagrams)
  if ((await shareRows.openFor(taskId, input.root, snapshot.rel, now())) !== undefined) {
    throw new HttpError(409, `${snapshot.rel} is already shared; update it or make a new link`)
  }
  const token = newToken()
  const id = randomUUID()
  const expires = new Date(Date.parse(at) + input.expires_in_days * DAY_MS).toISOString()
  await shareRows.insert(
    {
      id,
      token_hash: tokenHash(token),
      task_id: taskId,
      root: input.root,
      path: snapshot.rel,
      real_path: snapshot.real,
      name: snapshot.name,
      kind: snapshot.kind,
      mime: snapshot.mime,
      created_at: at,
      updated_at: at,
      expires_at: expires,
      revoked_at: null,
      version: 1,
      view_count: 0,
      scan_override: override,
      link_preview: input.link_preview,
      unfurl_count: 0,
    },
    body,
  )
  const share = await shareOf(id)
  await audit.record({
    actor: 'user',
    kind: 'task.file_shared',
    subject_type: 'task',
    subject_id: taskId,
    summary: `Shared ${snapshot.rel} of task "${files.task.title}" by public link until ${expires.slice(0, 10)}`,
    detail: { ...shareDetail(share), expires_at: expires, bytes: share.size, scan_override: override },
  })
  return { share, url: linkOf(origin, token) }
}

/** Republishes the same link with the file's content now, through every check again. */
export async function updateShare(
  id: string,
  allowFindings: boolean,
  diagrams: readonly ShareDiagramInput[] = [],
): Promise<Share> {
  await requireSharing()
  const row = await openShare(id)
  const snapshot = takeSnapshot(await fileContext(row.task_id), row.root, row.path)
  if (snapshot.real !== row.real_path) {
    throw new HttpError(409, `${row.path} now leads to another file; share that file on its own`)
  }
  const override = checked(snapshot, allowFindings)
  const fields = { name: snapshot.name, kind: snapshot.kind, mime: snapshot.mime, scan_override: override }
  const body = await renderShare(snapshot, diagrams)
  if (!(await shareRows.replace(id, fields, body, now()))) {
    throw new HttpError(404, 'This share has ended; share the file again')
  }
  const share = await shareOf(id)
  await audit.record({
    actor: 'user',
    kind: 'task.share_updated',
    subject_type: 'task',
    subject_id: row.task_id,
    summary: `Updated the shared copy of ${row.path} of task "${row.task_title}" to version ${String(share.version)}`,
    detail: { ...shareDetail(row), version: share.version, bytes: share.size, scan_override: override },
  })
  return share
}

/** A new token for the share; the old link stops working at once. */
export async function rotateShare(id: string, origin: string): Promise<ShareLink> {
  await requireSharing()
  const row = await openShare(id)
  const token = newToken()
  if (!(await shareRows.rotate(id, tokenHash(token), now()))) {
    throw new HttpError(404, 'This share has ended; share the file again')
  }
  await audit.record({
    actor: 'user',
    kind: 'task.share_link_rotated',
    subject_type: 'task',
    subject_id: row.task_id,
    summary: `Made a new link for ${row.path} of task "${row.task_title}"; the old link stopped working`,
    detail: shareDetail(row),
  })
  return { share: await shareOf(id), url: linkOf(origin, token) }
}

/** Ends a share and drops its copy; revoking works with sharing off too. */
export async function revokeShare(id: string): Promise<Share> {
  refuseAgent(WHAT)
  const row = await shareRows.get(id)
  if (row === undefined) {
    throw new HttpError(404, 'No such share')
  }
  if (await shareRows.revoke(id, now())) {
    await audit.record({
      actor: 'user',
      kind: 'task.share_revoked',
      subject_type: 'task',
      subject_id: row.task_id,
      summary: `Revoked the public link to ${row.path} of task "${row.task_title}"`,
      detail: shareDetail(row),
    })
  }
  return shareOf(id)
}

export async function revokeAllShares(): Promise<number> {
  refuseAgent(WHAT)
  const count = await shareRows.revokeAll(now())
  await audit.record({
    actor: 'user',
    kind: 'system.shares_revoked',
    subject_type: 'system',
    summary: `Revoked every public share link (${String(count)})`,
    detail: { count },
  })
  return count
}

export async function listShares(): Promise<ShareList> {
  refuseAgent(WHAT)
  await shareRows.purgeExpired(now())
  const rows = await shareRows.list()
  const views = await shareRows.recentViews(rows.map((row) => row.id))
  return { enabled: await sharingEnabled(), shares: rows.map((row) => toShare(row, views.get(row.id))) }
}

/** The open share of one file of a task, if any. */
export async function fileShare(taskId: string, root: string, path: string): Promise<FileShare> {
  refuseAgent(WHAT)
  await requireTask(taskId)
  const row = await shareRows.openFor(taskId, root, path, now())
  const views = row === undefined ? new Map<string, RecentViews>() : await shareRows.recentViews([row.id])
  return { enabled: await sharingEnabled(), share: row === undefined ? null : toShare(row, views.get(row.id)) }
}

/** Turns the link card on or off; off, a pasted link shows the file's name and nothing more. */
export async function setShareLinkPreview(id: string, on: boolean): Promise<Share> {
  await requireSharing()
  const row = await openShare(id)
  if (!(await shareRows.setLinkPreview(id, on, now()))) {
    throw new HttpError(404, 'This share has ended; share the file again')
  }
  await audit.record({
    actor: 'user',
    kind: 'task.share_link_preview',
    subject_type: 'task',
    subject_id: row.task_id,
    summary: `Turned ${on ? 'on' : 'off'} the link preview of ${row.path} of task "${row.task_title}"`,
    detail: { ...shareDetail(row), link_preview: on },
  })
  return shareOf(id)
}
