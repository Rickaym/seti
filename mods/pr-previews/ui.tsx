import { defineMod } from '@seti/mod-api'
import { previewBadge } from './PreviewBadge'
import manifest from './seti-mod.json' with { type: 'json' }

/** Puts a preview chip beside each PR that has a preview, linking to it while it is up. */
export const prPreviewsUi = defineMod({
  manifest,
  ui: (api) => {
    api.registerPrChip({ id: 'preview', view: previewBadge(api.kit) })
  },
})
