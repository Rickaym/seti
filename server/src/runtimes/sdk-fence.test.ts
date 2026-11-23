import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const TREES = ['server/src', 'shared/src', 'ui/src', 'packages', 'mods']
const SKIPPED = new Set(['node_modules', 'dist', 'build'])
const IMPORTS_SDK = /(?:from|import\()\s*'@anthropic-ai\/claude-agent-sdk'/

const fence = z.object({ sdkFence: z.function() })
const config = z.object({ ignores: z.array(z.string()) })

function sources(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      return SKIPPED.has(entry.name) ? [] : sources(file)
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [file] : []
  })
}

const importers = (): string[] =>
  TREES.flatMap(sources).filter((file) => IMPORTS_SDK.test(fs.readFileSync(path.join(ROOT, file), 'utf8')))

/** The adapter's folders and the files allowed outside them, as the ESLint fence ignores them. */
async function readFence() {
  const file = path.join(ROOT, 'eslint', 'sdk-fence.js')
  const { ignores } = config.parse(fence.parse(await import(file)).sdkFence())
  return {
    homes: ignores.filter((glob) => glob.endsWith('/**') && !glob.startsWith('*')).map((glob) => glob.slice(0, -2)),
    allowed: ignores.filter((glob) => !glob.includes('*')),
  }
}

describe('the Claude Agent SDK stays in its adapter', () => {
  it('is imported outside the adapter only by the files the fence allows', async () => {
    const { homes, allowed } = await readFence()
    const outside = importers().filter((file) => !homes.some((home) => file.startsWith(home)))
    expect(outside.filter((file) => !allowed.includes(file))).toEqual([])
  })

  it('allows only files that still import it, so the lists only shrink', async () => {
    const { allowed } = await readFence()
    const found = new Set(importers())
    expect(allowed.filter((file) => !found.has(file))).toEqual([])
  })
})
