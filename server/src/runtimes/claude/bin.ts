import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SDK = '@anthropic-ai/claude-agent-sdk'

function runnable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** `claude` in a PATH directory when it runs; a link whose target is gone does not count. */
export function claudeOnPath(pathEnv: string): string | null {
  const dirs = pathEnv.split(path.delimiter).filter((dir) => path.isAbsolute(dir))
  return dirs.map((dir) => path.join(dir, 'claude')).find(runnable) ?? null
}

/** The native Claude Code the Agent SDK ships for this machine, which its sessions run. */
function sdkClaude(): string | null {
  try {
    const require = createRequire(fileURLToPath(import.meta.resolve(SDK)))
    const base = `${SDK}-${process.platform}-${process.arch}`
    const variants = process.platform === 'linux' ? [base, `${base}-musl`] : [base]
    const found = variants.flatMap((pkg) => {
      try {
        return [require.resolve(`${pkg}/claude${process.platform === 'win32' ? '.exe' : ''}`)]
      } catch {
        return []
      }
    })
    return found.find(runnable) ?? null
  } catch {
    return null
  }
}

/** SETI_CLAUDE_BIN, else a working `claude` on PATH, else the Agent SDK's own binary. */
export function findClaudeBin(configured: string | undefined, pathEnv = process.env.PATH ?? ''): string {
  if (configured !== undefined && configured !== '') {
    return configured
  }
  return claudeOnPath(pathEnv) ?? sdkClaude() ?? 'claude'
}
