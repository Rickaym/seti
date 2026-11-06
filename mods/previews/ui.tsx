import { defineMod, type ModKit } from '@seti/mod-api'
import type { ComponentType } from 'react'
import { KitContext } from './kit'
import manifest from './seti-mod.json' with { type: 'json' }

/** A view inside the kit it draws its controls with. */
const withKit = <P extends object>(kit: ModKit, View: ComponentType<P>): ComponentType<P> =>
  function WithKit(props: P) {
    return (
      <KitContext.Provider value={kit}>
        <View {...props} />
      </KitContext.Provider>
    )
  }

/**
 * PDFs, tables and Mermaid diagrams, each loaded as its own chunk the first time such a file
 * opens; Seti registers each format only while its switch in the mod's settings is on.
 */
export const previewsUi = defineMod({
  manifest,
  ui: (api) => {
    const { kit } = api
    api.registerFileViewer({ id: 'pages', load: async () => import('./PdfView').then((m) => m.pdfView(kit)) })
    api.registerFileViewer({
      id: 'table',
      load: async () => import('./sheet-views').then((m) => withKit(kit, m.TableView)),
    })
    api.registerFileViewer({
      id: 'workbook',
      load: async () => import('./sheet-views').then((m) => withKit(kit, m.WorkbookView)),
    })
    api.registerFileViewer({
      id: 'diagram',
      load: async () => import('./MermaidDiagram').then((m) => withKit(kit, m.MermaidDiagram)),
    })
    api.registerFenceRenderer({
      language: 'mermaid',
      load: async () => import('./MermaidBlock').then((m) => withKit(kit, m.MermaidBlock)),
    })
  },
})
