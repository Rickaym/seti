import { projectCodex } from '@seti/shared'
import type { RuntimeAdapter } from '../adapter.js'
import { realiseCodex, type CodexProvider } from './realise.js'
import { codexSession, type CodexShapes } from './session.js'

/** Codex through `codex app-server`, one process per session, in Seti's sandbox only. */
export const codexAdapterFor = (binary: string, provider?: CodexProvider): RuntimeAdapter<CodexShapes, 'codex'> => ({
  id: 'codex',
  capabilities: {
    gate: { rewriteInput: false, classifier: false },
    session: { fork: 'none' },
    rewind: { conversation: false, code: false },
    dream: null,
  },
  project: projectCodex,
  realise: async (spec, launcher, host, abortController) =>
    Promise.resolve(
      realiseCodex(spec, launcher, {
        decide: host.decide,
        toolServers: host.toolServers,
        abortController,
        binary,
        ...(provider === undefined ? {} : { provider }),
      }),
    ),
  open: async (realised, input) => Promise.resolve(codexSession(realised, input)),
})
