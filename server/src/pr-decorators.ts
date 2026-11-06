import type { PrComment, PrDecoration, PrDecorator, PrSubject } from '@seti/mod-api'
import { Registry, setiSubdomainOf, type Preview } from '@seti/shared'
import { z } from 'zod'

/** A decorator a bundled mod registered, keyed `<mod>.<decorator>`. */
export interface PrDecoratorEntry {
  key: string
  decorate: PrDecorator
}

export const prDecorators = new Registry<PrDecoratorEntry>('PR decorator', (entry) => entry.key)

const NO_PREVIEW: Preview = { state: 'none', url: null, commit: null, stale: false }

const httpsOrigin = z
  .string()
  .refine((url) => URL.canParse(url) && new URL(url).protocol === 'https:' && new URL(url).origin === url)

const previewSchema = z.strictObject({
  state: z.enum(['ready', 'expired', 'none']),
  url: httpsOrigin.nullable(),
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/)
    .nullable(),
  stale: z.boolean(),
})

/** Whether any mod fills in previews, so Seti offers to request one. */
export const previewsOn = (): boolean => prDecorators.list().length > 0

function checked(decoration: PrDecoration): { preview: Preview; preview_host: string | null } {
  const preview = previewSchema.safeParse(decoration.preview)
  const host = decoration.preview_host ?? null
  return {
    preview: preview.success ? preview.data : NO_PREVIEW,
    preview_host: host !== null && setiSubdomainOf(host) === host ? host : null,
  }
}

/** The PR's preview fields from every decorator; one that throws or gives nonsense adds none. */
export function decoratePr(pr: PrSubject, comments: readonly PrComment[]) {
  let fields: { preview: Preview; preview_host: string | null } = { preview: NO_PREVIEW, preview_host: null }
  for (const entry of prDecorators.list()) {
    try {
      const next = checked(entry.decorate(pr, comments))
      fields = next.preview.state === 'none' ? fields : next
    } catch (e) {
      process.stderr.write(
        `mods: the PR decorator ${entry.key} failed: ${e instanceof Error ? e.message : String(e)}\n`,
      )
    }
  }
  return fields
}
