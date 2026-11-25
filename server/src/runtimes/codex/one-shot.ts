import { oneInput, type OneShot } from '../one-shot.js'
import { callCost } from './prices.js'
import { realiseOneShot, type CodexProvider } from './realise.js'
import { codexSession } from './session.js'

const REFUSAL = 'This call offers no tools; answer from what you were given.'

/**
 * Codex's one-shot: an app-server with no tool server and an ephemeral thread, whose every ask
 * Seti declines at once, run with the request's program unless a test bench names its own.
 */
export const codexOneShotFor = (binary?: string, provider?: CodexProvider): OneShot => ({
  open: async (request, launcher, abortController) => {
    const program = binary ?? request.program
    if (program === null) {
      throw new Error('Codex is not installed.')
    }
    const realised = realiseOneShot(request, launcher, {
      decide: async () => Promise.resolve({ allow: false, message: REFUSAL }),
      abortController,
      binary: program,
      ...(provider === undefined ? {} : { provider }),
    })
    return Promise.resolve(codexSession(realised, oneInput(request.prompt)))
  },
  price: callCost,
})
