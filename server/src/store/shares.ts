import type { FileKind, ShareView } from '@seti/shared'
import { sql, transaction, type Db } from '../db.js'

export interface ShareRow {
  id: string
  task_id: string
  root: string
  path: string
  /** The file's real path when shared; an update must find the same file there. */
  real_path: string
  name: string
  kind: FileKind
  mime: string
  created_at: string
  updated_at: string
  expires_at: string
  revoked_at: string | null
  version: number
  view_count: number
  scan_override: boolean
  link_preview: boolean
  unfurl_count: number
}

/** A share with its agent's title and the size of what it holds now. */
export interface ShareListRow extends ShareRow {
  task_title: string
  size: number
  assets: number
  preview_label: string | null
  preview_note: string | null
  preview_error: string | null
  images: number
  card: boolean
}

/** A Markdown file's image, by the link the file names it with; its bytes are inline in the page. */
export interface ShareAssetRow {
  ref: string
  mime: string
  size: number
}

/** An image the page shows from the share's image path, by its number there. */
export interface ShareImageRow {
  mime: string
  bytes: Buffer
}

/** What a share serves: the file's bytes and its page body, rendered when it was copied. */
export interface ShareContent {
  content: Buffer
  sha256: string
  page: string
  assets: ShareAssetRow[]
  images: ShareImageRow[]
  /** The key image sources carry in the page; null when it shows no stored images. */
  image_key: string | null
  preview_label: string
  preview_note: string | null
  preview_error: string | null
  /** The link card PNG, or null when it could not be made. */
  card: Buffer | null
}

/** What a create, update or new link changes on the share row. */
export interface ShareFields {
  name: string
  kind: FileKind
  mime: string
  scan_override: boolean
}

/** A share's latest views by people and fetches by link preview bots. */
export interface RecentViews {
  views: ShareView[]
  unfurls: ShareView[]
}

const VIEWS_KEPT = 100
const RECENT_VIEWS = 5

const LIST_COLUMNS = sql`s.id, s.task_id, s.root, s.path, s.real_path, s.name, s.kind, s.mime, s.created_at,
  s.updated_at, s.expires_at, s.revoked_at, s.version, s.view_count, s.scan_override, s.link_preview, s.unfurl_count,
  t.title AS task_title, coalesce(b.size, 0)::int AS size,
  (SELECT count(*)::int FROM share_asset a WHERE a.share_id = s.id) AS assets,
  b.preview_label, b.preview_note, b.preview_error, coalesce(b.card IS NOT NULL, false) AS card,
  (SELECT count(*)::int FROM share_image i WHERE i.share_id = s.id) AS images`

const LIST_FROM = sql`share s JOIN task t ON t.id = s.task_id LEFT JOIN share_blob b ON b.share_id = s.id`

/** Bytes a share's previews take: its page, images and card, beside the file itself. */
const previewBytes = (body: ShareContent) =>
  Buffer.byteLength(body.page) +
  body.images.reduce((sum, image) => sum + image.bytes.length, 0) +
  (body.card?.length ?? 0)

async function writeContent(tx: Db, id: string, body: ShareContent): Promise<void> {
  await tx`DELETE FROM share_asset WHERE share_id = ${id}`
  await tx`DELETE FROM share_image WHERE share_id = ${id}`
  await tx`INSERT INTO share_blob (share_id, content, page, size, sha256, preview_label, preview_note, preview_error,
      image_key, card, preview_bytes)
    VALUES (${id}, ${body.content}, ${body.page}, ${body.content.length}, ${body.sha256}, ${body.preview_label},
      ${body.preview_note}, ${body.preview_error}, ${body.image_key}, ${body.card}, ${previewBytes(body)})
    ON CONFLICT (share_id) DO UPDATE SET content = excluded.content, page = excluded.page, size = excluded.size,
      sha256 = excluded.sha256, preview_label = excluded.preview_label, preview_note = excluded.preview_note,
      preview_error = excluded.preview_error, image_key = excluded.image_key, card = excluded.card,
      preview_bytes = excluded.preview_bytes`
  for (const asset of body.assets) {
    await tx`INSERT INTO share_asset (share_id, ref, mime, size) VALUES (${id}, ${asset.ref}, ${asset.mime}, ${asset.size})`
  }
  for (const [n, image] of body.images.entries()) {
    await tx`INSERT INTO share_image (share_id, n, mime, bytes) VALUES (${id}, ${n + 1}, ${image.mime}, ${image.bytes})`
  }
}

/** Drops what shares serve, every share's when ids is null; the rows stay for the list and audit. */
async function dropContent(tx: Db, ids: readonly string[] | null): Promise<void> {
  if (ids === null) {
    await tx`DELETE FROM share_blob`
    await tx`DELETE FROM share_asset`
    await tx`DELETE FROM share_image`
    return
  }
  await tx`DELETE FROM share_blob WHERE share_id = ANY(${[...ids]}::text[])`
  await tx`DELETE FROM share_asset WHERE share_id = ANY(${[...ids]}::text[])`
  await tx`DELETE FROM share_image WHERE share_id = ANY(${[...ids]}::text[])`
}

export const shareSettings = {
  /** Sharing starts off: the row is made on first read with the switch off. */
  enabled: async (at: string): Promise<boolean> => {
    await sql`INSERT INTO share_settings (id, enabled, updated_at) VALUES (1, false, ${at})
      ON CONFLICT (id) DO NOTHING`
    const [row] = await sql<{ enabled: boolean }[]>`SELECT enabled FROM share_settings WHERE id = 1`
    return row?.enabled ?? false
  },
  set: async (enabled: boolean, at: string): Promise<void> => {
    await sql`INSERT INTO share_settings (id, enabled, updated_at) VALUES (1, ${enabled}, ${at})
      ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`
  },
}

export const shareRows = {
  insert: async (row: ShareRow & { token_hash: string }, body: ShareContent): Promise<void> =>
    transaction(async (tx) => {
      await tx`INSERT INTO share (id, token_hash, task_id, root, path, real_path, name, kind, mime, created_at,
          updated_at, expires_at, revoked_at, version, view_count, scan_override, link_preview, unfurl_count)
        VALUES (${row.id}, ${row.token_hash}, ${row.task_id}, ${row.root}, ${row.path}, ${row.real_path}, ${row.name},
          ${row.kind}, ${row.mime}, ${row.created_at}, ${row.updated_at}, ${row.expires_at}, ${row.revoked_at},
          ${row.version}, ${row.view_count}, ${row.scan_override}, ${row.link_preview}, ${row.unfurl_count})`
      await writeContent(tx, row.id, body)
    }),
  /** Swaps in a new snapshot and bumps the version, while the share is still open. */
  replace: async (id: string, fields: ShareFields, body: ShareContent, at: string): Promise<boolean> =>
    transaction(async (tx) => {
      const updated = await tx`UPDATE share SET name = ${fields.name}, kind = ${fields.kind}, mime = ${fields.mime},
          scan_override = ${fields.scan_override}, version = version + 1, updated_at = ${at}
        WHERE id = ${id} AND revoked_at IS NULL AND expires_at > ${at} RETURNING id`
      if (updated.length === 0) {
        return false
      }
      await writeContent(tx, id, body)
      return true
    }),
  rotate: async (id: string, tokenHash: string, at: string): Promise<boolean> =>
    (
      await sql`UPDATE share SET token_hash = ${tokenHash}, updated_at = ${at}
        WHERE id = ${id} AND revoked_at IS NULL AND expires_at > ${at} RETURNING id`
    ).length > 0,
  /** Turns the link card on or off, while the share is still open. */
  setLinkPreview: async (id: string, on: boolean, at: string): Promise<boolean> =>
    (
      await sql`UPDATE share SET link_preview = ${on}
        WHERE id = ${id} AND revoked_at IS NULL AND expires_at > ${at} RETURNING id`
    ).length > 0,
  /** Ends the share and drops its bytes; the row stays for the list and the audit trail. */
  revoke: async (id: string, at: string): Promise<boolean> =>
    transaction(async (tx) => {
      const ended = await tx`UPDATE share SET revoked_at = ${at} WHERE id = ${id} AND revoked_at IS NULL RETURNING id`
      await dropContent(tx, [id])
      return ended.length > 0
    }),
  revokeAll: async (at: string): Promise<number> =>
    transaction(async (tx) => {
      const ended = await tx<{ expires_at: string }[]>`UPDATE share SET revoked_at = ${at} WHERE revoked_at IS NULL
        RETURNING expires_at`
      await dropContent(tx, null)
      return ended.filter((row) => row.expires_at > at).length
    }),
  /** Drops the bytes of shares that expired; their rows stay for the list. */
  purgeExpired: async (at: string): Promise<void> =>
    transaction(async (tx) => {
      const ended = await tx<{ id: string }[]>`SELECT id FROM share WHERE expires_at <= ${at}`
      await dropContent(
        tx,
        ended.map((row) => row.id),
      )
    }),
  get: async (id: string): Promise<ShareListRow | undefined> =>
    (await sql<ShareListRow[]>`SELECT ${LIST_COLUMNS} FROM ${LIST_FROM} WHERE s.id = ${id}`).at(0),
  /** The open share of a file, if any. */
  openFor: async (taskId: string, root: string, path: string, at: string): Promise<ShareListRow | undefined> =>
    (
      await sql<ShareListRow[]>`SELECT ${LIST_COLUMNS} FROM ${LIST_FROM}
        WHERE s.task_id = ${taskId} AND s.root = ${root} AND s.path = ${path}
          AND s.revoked_at IS NULL AND s.expires_at > ${at}
        ORDER BY s.created_at DESC LIMIT 1`
    ).at(0),
  list: async (): Promise<ShareListRow[]> =>
    sql<ShareListRow[]>`SELECT ${LIST_COLUMNS} FROM ${LIST_FROM} ORDER BY s.created_at DESC, s.id`,
  /** The few latest views and link previews of each share, apart and newest first. */
  recentViews: async (ids: readonly string[]): Promise<Map<string, RecentViews>> => {
    const rows = await sql<(ShareView & { share_id: string })[]>`SELECT share_id, at, country, user_agent, unfurler
      FROM (SELECT v.*, row_number() OVER (PARTITION BY share_id, unfurler IS NULL ORDER BY id DESC) AS n
        FROM share_view v WHERE share_id = ANY(${[...ids]}::text[])) ranked
      WHERE n <= ${RECENT_VIEWS} ORDER BY id DESC`
    const views = new Map<string, RecentViews>()
    for (const { share_id, ...view } of rows) {
      const recent = views.get(share_id) ?? { views: [], unfurls: [] }
      if (view.unfurler === null) {
        recent.views.push(view)
      } else {
        recent.unfurls.push(view)
      }
      views.set(share_id, recent)
    }
    return views
  },
}

/** The only reads the public share route makes. */
export type PublicShareRow = Pick<
  ShareRow,
  'id' | 'name' | 'kind' | 'mime' | 'updated_at' | 'expires_at' | 'revoked_at' | 'link_preview'
>

/** The stored page and what its head tells link previews. */
export interface PublicPage {
  page: string
  size: number
  image_key: string | null
  preview_label: string
  card: boolean
}

export const publicShares = {
  byTokenHash: async (hash: string): Promise<PublicShareRow | undefined> =>
    (
      await sql<PublicShareRow[]>`SELECT id, name, kind, mime, updated_at, expires_at, revoked_at, link_preview
        FROM share WHERE token_hash = ${hash}`
    ).at(0),
  content: async (id: string): Promise<Buffer | undefined> =>
    (await sql<{ content: Buffer }[]>`SELECT content FROM share_blob WHERE share_id = ${id}`).at(0)?.content,
  /** The file's size, without reading its bytes. */
  size: async (id: string): Promise<number | undefined> =>
    (await sql<{ size: number }[]>`SELECT size FROM share_blob WHERE share_id = ${id}`).at(0)?.size,
  /** Bytes of the file from start, read alone: the content is stored uncompressed for this. */
  slice: async (id: string, start: number, length: number): Promise<Buffer | undefined> =>
    (
      await sql<{ part: Buffer }[]>`SELECT substring(content FROM ${start + 1}::int FOR ${length}::int) AS part
        FROM share_blob WHERE share_id = ${id}`
    ).at(0)?.part,
  /** The page body and what its head needs, without reading the file's bytes. */
  page: async (id: string): Promise<PublicPage | undefined> =>
    (
      await sql<PublicPage[]>`SELECT page, size, image_key, preview_label, card IS NOT NULL AS card
        FROM share_blob WHERE share_id = ${id}`
    ).at(0),
  /** One of the page's stored images, by its number. */
  image: async (id: string, n: number): Promise<ShareImageRow | undefined> =>
    (await sql<ShareImageRow[]>`SELECT mime, bytes FROM share_image WHERE share_id = ${id} AND n = ${n}`).at(0),
  card: async (id: string): Promise<Buffer | undefined> =>
    (await sql<{ card: Buffer | null }[]>`SELECT card FROM share_blob WHERE share_id = ${id}`).at(0)?.card ?? undefined,
  /** Counts a view, or a link preview when a bot fetched it, and logs it, keeping the latest. */
  recordView: async (id: string, view: ShareView): Promise<void> =>
    transaction(async (tx) => {
      if (view.unfurler === null) {
        await tx`UPDATE share SET view_count = view_count + 1 WHERE id = ${id}`
      } else {
        await tx`UPDATE share SET unfurl_count = unfurl_count + 1 WHERE id = ${id}`
      }
      await tx`INSERT INTO share_view (share_id, at, country, user_agent, unfurler)
        VALUES (${id}, ${view.at}, ${view.country}, ${view.user_agent}, ${view.unfurler})`
      await tx`DELETE FROM share_view WHERE share_id = ${id} AND id NOT IN (
        SELECT id FROM share_view WHERE share_id = ${id} ORDER BY id DESC LIMIT ${VIEWS_KEPT})`
    }),
}
