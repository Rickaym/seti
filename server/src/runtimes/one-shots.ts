import type { RuntimeId } from './adapter.js'
import { claudeOneShot } from './claude/one-shot.js'
import { codexOneShotFor } from './codex/one-shot.js'
import type { OneShot } from './one-shot.js'

const ONE_SHOTS: Record<RuntimeId, OneShot> = { claude: claudeOneShot, codex: codexOneShotFor() }

/**
 * The runtime's one-shot, until its adapter's capabilities declare one. The control plane alone
 * runs one-shots, so the node never loads this module or the settings Codex's reads.
 */
export const oneShotFor = (id: RuntimeId): OneShot => ONE_SHOTS[id]
