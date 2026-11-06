import { PREVIEW_LABEL, prKey, type PreviewRequest } from '@seti/shared'
import { audit } from './audit.js'
import { HttpError } from './http.js'
import { previewsOn } from './pr-decorators.js'
import { redeployPreview } from './prs.js'

/** What request_preview answers while no mod fills in previews. */
export const PREVIEWS_OFF = 'PR previews are off. The user can turn them on in Settings, Mods.'

/** Requests a preview: adds the preview label, or removes and re-adds it, and audits it. */
export async function requestPreview(owner: string, name: string, number: number): Promise<PreviewRequest> {
  if (!previewsOn()) {
    throw new HttpError(409, PREVIEWS_OFF)
  }
  const relabeled = await redeployPreview(owner, name, number)
  const slug = `${owner}/${name}`
  const ref = `${slug}#${String(number)}`
  await audit.record({
    actor: 'user',
    kind: 'pr.redeploy_requested',
    subject_type: 'pr',
    subject_id: prKey(slug, number),
    summary: relabeled
      ? `Removed and re-added the ${PREVIEW_LABEL} label on ${ref} to redeploy its preview`
      : `Added the ${PREVIEW_LABEL} label to ${ref} to deploy its preview`,
    detail: { repo: slug, number, label: PREVIEW_LABEL, label_change: relabeled ? 'removed and re-added' : 'added' },
  })
  return { label: PREVIEW_LABEL, relabeled }
}
