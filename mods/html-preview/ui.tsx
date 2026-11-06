import { defineMod } from '@seti/mod-api'
import manifest from './seti-mod.json' with { type: 'json' }

/** Shows HTML files as sandboxed pages, which Seti serves to the frame only while this mod runs. */
export const htmlPreviewUi = defineMod({
  manifest,
  ui: (api) => {
    api.registerFileViewer({ id: 'page', load: async () => import('./HtmlPreview').then((m) => m.pageView(api.kit)) })
  },
})
