import { GEMINI_ROOT } from '../../config.js'
import { entryIn } from '../../gemini-fetch.js'
import { GEMINI_PIN } from '../../gemini-pin.js'
import { GEMINI_CONFIG_MOUNT } from '../../sandbox-gemini.js'
import { acpAdapterFor } from '../acp/adapter.js'
import { geminiLaunch } from './launch.js'

/** Gemini CLI as Seti runs it: its pinned copy under this Node, with Seti's files in the sandbox. */
export const geminiAdapter = acpAdapterFor(
  'gemini',
  geminiLaunch({
    node: process.execPath,
    entry: entryIn(GEMINI_ROOT, GEMINI_PIN.version),
    config: GEMINI_CONFIG_MOUNT,
  }),
)
