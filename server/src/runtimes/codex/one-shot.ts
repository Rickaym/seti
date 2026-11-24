import { oneInput, type OneShot } from '../one-shot.js'
import { callCost } from './prices.js'
import { realiseOneShot, type CodexProvider } from './realise.js'
import { codexSession } from './session.js'

const REFUSAL = 'This call offers no tools; answer from what you were given.'

/**
 * Codex's one-shot: an app-server with no tool server and an ephemeral thread, whose every ask
 * Seti declines at once, run with the program `program` finds when the call starts.
 */
export const codexOneShotFor = (program: () => Promise<string | null>, provider?: CodexProvider): OneShot => ({
  open: async (request, launcher, abortController) => {
    const binary = await program()
    if (binary === null) {
      throw new Error('Codex is not installed.')
    }
    const realised = realiseOneShot(request, launcher, {
      decide: async () => Promise.resolve({ allow: false, message: REFUSAL }),
      abortController,
      binary,
      ...(provider === undefined ? {} : { provider }),
    })
    return codexSession(realised, oneInput(request.prompt))
  },
  price: callCost,
})
