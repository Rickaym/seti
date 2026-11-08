import type { ModColorScheme } from '@seti/mod-api'
import { renderMermaid, type DiagramTheme } from './diagram-render'

/** Arial where the browser has it and Liberation Sans, of the same widths, where the server draws. */
const SHARE_FONT = 'Arial, "Liberation Sans", Helvetica, sans-serif'

const SHARE_THEMES: Record<ModColorScheme, DiagramTheme> = {
  light: { key: 'share-light', background: '', dark: false, font: SHARE_FONT, variables: {}, preset: 'default' },
  dark: { key: 'share-dark', background: '', dark: true, font: SHARE_FONT, variables: {}, preset: 'dark' },
}

/** A diagram as a share page shows it: Mermaid's own light or dark theme, not Seti's. */
export async function shareSnapshot(source: string, scheme: ModColorScheme): Promise<string | null> {
  const drawn = await renderMermaid(source, SHARE_THEMES[scheme])
  return 'svg' in drawn ? drawn.svg : null
}
