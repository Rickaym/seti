import type { ModDefinition } from '@seti/mod-api'
import blobs from '@seti/mod-blobs/seti-mod.json' with { type: 'json' }
import catppuccin from '@seti/mod-catppuccin/seti-mod.json' with { type: 'json' }
import claudeTheme from '@seti/mod-claude-theme/seti-mod.json' with { type: 'json' }
import { githubWebhooksServer } from '@seti/mod-github-webhooks/server'
import { gridServer } from '@seti/mod-grid/server'
import htmlPreview from '@seti/mod-html-preview/seti-mod.json' with { type: 'json' }
import { pollerTemplatesServer } from '@seti/mod-poller-templates/server'
import { prPreviewsServer } from '@seti/mod-pr-previews/server'
import previews from '@seti/mod-previews/seti-mod.json' with { type: 'json' }
import { sampleServer } from '@seti/mod-sample/server'
import { sentryWebhooksServer } from '@seti/mod-sentry-webhooks/server'
import { sideChatServer } from '@seti/mod-side-chat/server'
import twemoji from '@seti/mod-twemoji/seti-mod.json' with { type: 'json' }
import vim from '@seti/mod-vim/seti-mod.json' with { type: 'json' }
import { weatherServer } from '@seti/mod-weather/server'
import { whatsNewServer } from '@seti/mod-whats-new/server'
import type { ModTier } from '@seti/shared'
import { SAFE_MODE_FORCED, TEST_MODS_ON } from '../config.js'
import { startViewTestMod, viewTestMod } from './frames/view-test.js'
import { ModHost } from './host.js'
import { installedMods, pinProblem } from './installed.js'

/** Every mod in mods/ that ships with Seti, by its server half or, with none, its manifest. */
export const BUNDLED_MODS: readonly ModDefinition[] = [
  { manifest: blobs },
  githubWebhooksServer,
  gridServer,
  { manifest: htmlPreview },
  pollerTemplatesServer,
  prPreviewsServer,
  { manifest: previews },
  sentryWebhooksServer,
  sideChatServer,
  { manifest: twemoji },
  { manifest: vim },
  weatherServer,
  whatsNewServer,
]

/** Theme mods: a manifest and token values, with no code. */
export const THEME_MODS: readonly ModDefinition[] = [{ manifest: catppuccin }, { manifest: claudeTheme }]

/** Mods only Seti's own tests use; SETI_TEST_MODS=1 loads them in a development or test run. */
export const TEST_MODS: readonly ModDefinition[] = [sampleServer]

/** Third-party mods only Seti's own tests use, with their pages served from memory. */
const TEST_THIRD_PARTY_MODS: readonly ModDefinition[] = TEST_MODS_ON ? [viewTestMod] : []
if (TEST_MODS_ON) {
  startViewTestMod()
}

const tiered = (definitions: readonly ModDefinition[], tier: ModTier) =>
  definitions.map((definition) => ({ definition, tier }))

/** The server's one mod host. */
export const modHost = new ModHost(
  [
    ...tiered(BUNDLED_MODS, 'bundled'),
    ...tiered(THEME_MODS, 'theme'),
    ...tiered(TEST_MODS_ON ? TEST_MODS : [], 'bundled'),
    ...tiered(TEST_THIRD_PARTY_MODS, 'third-party'),
  ],
  { safeModeForced: SAFE_MODE_FORCED, pinProblem, installed: installedMods },
)
