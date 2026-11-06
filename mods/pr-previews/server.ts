import { defineMod, type OpenPrSummary } from '@seti/mod-api'
import { detectPreview } from './detect.js'
import { previewHost, previewTarget } from './hosts.js'
import manifest from './seti-mod.json' with { type: 'json' }

/** How long one read of the open PRs serves the requests of a preview page. */
const OPEN_PRS_MS = 5000

/** Reads each PR's preview from the Actions bot's comments and serves it on a Seti subdomain. */
export const prPreviewsServer = defineMod({
  manifest,
  server: (api) => {
    api.prs.decorate('preview', (pr, comments) => {
      const preview = detectPreview(comments, pr.headOid)
      return { preview, preview_host: preview.state === 'ready' ? previewHost(pr.slug, pr.number) : null }
    })
    let recent: { at: number; prs: Promise<OpenPrSummary[]> } | null = null
    const openPrs = async () => {
      if (recent === null || Date.now() - recent.at > OPEN_PRS_MS) {
        recent = { at: Date.now(), prs: api.prs.open() }
      }
      return recent.prs
    }
    api.registerHostProxy('preview', async (hostname) => previewTarget(await openPrs(), hostname))
  },
})
