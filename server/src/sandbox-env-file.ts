import fs from 'node:fs'
import { gitCheckoutAbove, writePrivateFile } from './private-file.js'
import { SANDBOX_RUN } from './sandbox-mounts.js'

const FILE = 'env.sh'

/** Where a sandbox's shells read the connection variables of the agent's credential as it is now. */
export const SANDBOX_ENV_FILE = `${SANDBOX_RUN}/${FILE}`

const NAME = /^[A-Za-z_]\w*$/
const PLACEHOLDER = /^[\w.:@+=,/-]*$/

/** One export line per variable a shell takes as it is; any other name or value is left out. */
export const envFileText = (vars: Readonly<Record<string, string>>): string =>
  Object.entries(vars)
    .filter(([name, value]) => NAME.test(name) && PLACEHOLDER.test(value))
    .map(([name, value]) => `export ${name}='${value}'\n`)
    .join('')

/**
 * Writes the placeholders, never a value, to the env file in a sandbox's run folder, which
 * the sandbox mounts read-only and names in BASH_ENV. False when the folder is missing or
 * inside a git checkout.
 */
export function writeSandboxEnv(runDir: string, vars: Readonly<Record<string, string>>): boolean {
  if (!fs.existsSync(runDir) || gitCheckoutAbove(runDir) !== null) {
    return false
  }
  writePrivateFile(runDir, FILE, envFileText(vars))
  return true
}

/** What a sandboxed agent learns of a variable it has from now on, in a turn that goes on. */
export const liveVariableText = (env: string): string =>
  `Your bash commands have $${env} from now on, so carry on with your work in this turn; another shell, ` +
  `or a process started before now such as an MCP server, gets it with \`. ${SANDBOX_ENV_FILE}\`.`
