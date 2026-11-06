import type { ModDefinition } from '@seti/mod-api'
import catppuccin from '@seti/mod-catppuccin/tokens.css?inline'
import claudeTheme from '@seti/mod-claude-theme/tokens.css?inline'

/** The UI half of each bundled mod that has one, loaded as its own chunk when the mod is on. */
export const UI_MODS: Readonly<Record<string, () => Promise<ModDefinition>>> = {
  blobs: async () => import('@seti/mod-blobs/ui').then((m) => m.blobsUi),
  grid: async () => import('@seti/mod-grid/ui').then((m) => m.gridUi),
  'html-preview': async () => import('@seti/mod-html-preview/ui').then((m) => m.htmlPreviewUi),
  'pr-previews': async () => import('@seti/mod-pr-previews/ui').then((m) => m.prPreviewsUi),
  previews: async () => import('@seti/mod-previews/ui').then((m) => m.previewsUi),
  sample: async () => import('@seti/mod-sample/ui').then((m) => m.sampleUi),
  'side-chat': async () => import('@seti/mod-side-chat/ui').then((m) => m.sideChatUi),
  vim: async () => import('@seti/mod-vim/ui').then((m) => m.vimUi),
  weather: async () => import('@seti/mod-weather/ui').then((m) => m.weatherUi),
  'whats-new': async () => import('@seti/mod-whats-new/ui').then((m) => m.whatsNewUi),
}

/** Bundled mods' stylesheets by `<mod>.<style>`, each a chunk loaded while its mod is on. */
export const MOD_STYLES: Readonly<Record<string, () => Promise<string>>> = {
  'blobs.blobs': async () => import('@seti/mod-blobs/blobs.css?inline').then((m) => m.default),
  'grid.panels': async () => import('@seti/mod-grid/panels.css?inline').then((m) => m.default),
  'twemoji.emoji': async () => import('@seti/mod-twemoji/emoji.css?inline').then((m) => m.default),
}

/** The token CSS of each theme mod, in the main bundle so a chosen theme paints with the page. */
export const THEME_TOKENS: Readonly<Record<string, string>> = {
  catppuccin,
  'claude-theme': claudeTheme,
}
