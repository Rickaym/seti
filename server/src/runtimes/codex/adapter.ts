import { projectCodex } from '@seti/shared'
import type { RuntimeAdapter } from '../adapter.js'
import { codexOneShotFor } from './one-shot.js'
import { realiseCodex, SERVER_NAMES, type CodexProvider } from './realise.js'
import { codexSession, type CodexShapes } from './session.js'

/**
 * Codex through `codex app-server`, one process per session, in Seti's sandbox only; the program
 * is the spec's unless a test bench names its own.
 */
export const codexAdapterFor = (binary?: string, provider?: CodexProvider): RuntimeAdapter<CodexShapes, 'codex'> => ({
  id: 'codex',
  capabilities: {
    gate: { rewriteInput: false, classifier: false },
    session: { fork: 'none' },
    rewind: { conversation: false, code: false },
    tools: { userServers: ['stdio', 'http'], serverNames: SERVER_NAMES, plugins: false },
    sandbox: { optional: false },
    compaction: false,
    subagents: false,
    dream: null,
    oneShot: codexOneShotFor(binary, provider),
  },
  project: projectCodex,
  realise: async (spec, launcher, host, abortController) =>
    Promise.resolve(
      realiseCodex(spec, launcher, {
        decide: host.decide,
        toolServers: host.toolServers,
        abortController,
        binary: binary ?? spec.vendor.binary,
        ...(provider === undefined ? {} : { provider }),
      }),
    ),
  open: async (realised, input) => Promise.resolve(codexSession(realised, input)),
})

/** Codex as agents run it, with the program the user named in its settings. */
export const codexAdapter = codexAdapterFor()
