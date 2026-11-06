import { defineMod } from '@seti/mod-api'
import { useMemo } from 'react'
import { blobSettings } from './look'
import manifest from './seti-mod.json' with { type: 'json' }
import { blobViews } from './views'

/** Agents as blobs with eyes, on row edges and as status markers; the stylesheet follows the mod. */
export const blobsUi = defineMod({
  manifest,
  ui: (api) => {
    function useBlobSettings() {
      const values = api.useSettings()
      return useMemo(() => blobSettings(values), [values])
    }
    const { Blob, BlobBookmark } = blobViews(useBlobSettings)
    api.registerStatusMarker({ id: 'blobs', view: Blob })
    api.registerAgentAccent({ id: 'blobs', view: BlobBookmark })
  },
})
