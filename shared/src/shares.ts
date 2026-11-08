import { z } from 'zod'
import type { FileKind } from './files.js'

/** Public share links live under this path on Seti's own origin. */
export const SHARE_PREFIX = '/share/'

/** The days a new link stays open, the middle one by default. */
export const SHARE_EXPIRY_DAYS = [1, 7, 30] as const
export type ShareExpiryDays = (typeof SHARE_EXPIRY_DAYS)[number]

/** The most bytes one share holds, a Markdown file's images included. */
export const SHARE_MAX_BYTES = 10 * 1024 * 1024

const sharePath = {
  root: z.string().min(1).max(64),
  path: z.string().min(1).max(4096),
}

/** The most diagrams one share draws, each in a light and a dark image. */
export const SHARE_DIAGRAMS_MAX = 16
/** The longest fence source a share draws as a diagram. */
export const SHARE_DIAGRAM_SOURCE_MAX = 64 * 1024
/** The largest drawing of one diagram the browser may send. */
export const SHARE_DIAGRAM_SVG_MAX = 1024 * 1024
/** The most every drawing of one request may take together. */
export const SHARE_DIAGRAMS_BYTES_MAX = 6 * 1024 * 1024

const drawing = z
  .string()
  .max(SHARE_DIAGRAM_SVG_MAX)
  .regex(/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/, 'A drawing is an SVG document')

/**
 * A fence the browser drew with the mod that draws its language, for a share page that runs no
 * script. The server rasterizes each drawing and uses it only where a fence has this exact text.
 */
export const shareDiagramInput = z
  .object({
    language: z
      .string()
      .max(32)
      .regex(/^[a-z][a-z0-9+#-]*$/),
    source: z.string().min(1).max(SHARE_DIAGRAM_SOURCE_MAX),
    light: drawing,
    dark: drawing,
  })
  .strict()
export type ShareDiagramInput = z.infer<typeof shareDiagramInput>

const shareDiagrams = z
  .array(shareDiagramInput)
  .max(SHARE_DIAGRAMS_MAX)
  .refine(
    (diagrams) => diagrams.reduce((sum, d) => sum + d.light.length + d.dark.length, 0) <= SHARE_DIAGRAMS_BYTES_MAX,
    'The drawings are larger than a share takes',
  )
  .default([])

export const createShareInput = z
  .object({
    ...sharePath,
    /** Diagrams drawn for the page; a fence without one shows as code. */
    diagrams: shareDiagrams,
    expires_in_days: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(7),
    /** Shares a file the secret scan flagged; the share records that it was overridden. */
    allow_findings: z.boolean().default(false),
    /** Chat apps show a card with the file's name, kind, size and a thumbnail when the link is pasted. */
    link_preview: z.boolean().default(true),
  })
  .strict()
export type CreateShareInput = z.input<typeof createShareInput>

export const updateShareInput = z
  .object({ allow_findings: z.boolean().default(false), diagrams: shareDiagrams })
  .strict()
export type UpdateShareInput = z.input<typeof updateShareInput>

export const shareLinkPreviewInput = z.object({ link_preview: z.boolean() }).strict()
export type ShareLinkPreviewInput = z.input<typeof shareLinkPreviewInput>

export const shareFileQuery = z.object(sharePath)

export const sharingInput = z.object({ enabled: z.boolean() }).strict()
export type SharingInput = z.input<typeof sharingInput>

/** One open of a share's page or download. */
export interface ShareView {
  at: string
  /** Cloudflare's two-letter country of the viewer, or null when unknown. */
  country: string | null
  user_agent: string
  /** The chat app or site whose bot fetched the page for a link preview; null for a person. */
  unfurler: string | null
}

/** What the share page shows, as rendered when the file was shared or updated. */
export interface SharePreview {
  /** What the file is, such as "PDF, 12 pages"; empty for shares made before previews. */
  label: string
  /** What the page leaves out, such as "first 1,000 rows shown". */
  note: string | null
  /** Why a converter could not show the file; the page falls back to its source or download. */
  error: string | null
  /** Page and output images the share stores. */
  images: number
  /** Whether a link card image was made. */
  card: boolean
}

export interface Share {
  id: string
  task_id: string
  task_title: string
  root: string
  path: string
  name: string
  kind: FileKind
  size: number
  /** Relative images of a Markdown file, snapshotted with it. */
  assets: number
  version: number
  created_at: string
  updated_at: string
  expires_at: string
  revoked_at: string | null
  /** The file was shared although the secret scan flagged it. */
  scan_override: boolean
  view_count: number
  recent_views: ShareView[]
  /** Chat apps may show a card for the link; off, the page names only the file. */
  link_preview: boolean
  /** Fetches by link preview bots, which are not counted as views. */
  unfurl_count: number
  recent_unfurls: ShareView[]
  preview: SharePreview
}

/** A share with its link, which Seti shows only now: it keeps no copy of the token. */
export interface ShareLink {
  share: Share
  url: string
}

/** A line the secret scan flagged, by its kind; the value itself never leaves the server. */
export interface ShareFinding {
  line: number
  kind: string
}

/** The 409 a share gets when the secret scan flags the file and the request did not allow it. */
export interface ShareScanRefusal {
  error: { title: string; detail: string }
  findings: ShareFinding[]
}

export interface ShareList {
  enabled: boolean
  shares: Share[]
}

/** The share of one file, if any, and whether sharing is on. */
export interface FileShare {
  enabled: boolean
  share: Share | null
}

/** Rotate and revoke-all take no fields. */
export const emptyShareInput = z.object({}).strict()
