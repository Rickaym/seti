import path from 'node:path'
import { codexPinSchema, fetchPinned, removeFetched } from './codex-fetch.js'
import pin from './runtimes/codex/pin.json' with { type: 'json' }

/** Fetches the pinned Codex into `<folder>/<version>/codex` as Seti does, and prints its path. */
async function main(): Promise<void> {
  const folder = process.argv[2]
  if (folder === undefined || folder === '') {
    process.stderr.write('usage: pnpm --silent --filter @seti/server run codex-binary <folder>\n')
    process.exitCode = 1
    return
  }
  try {
    const root = path.resolve(folder)
    const { program } = await fetchPinned({ pin: codexPinSchema.parse(pin), root, discard: removeFetched })
    process.stdout.write(`${program}\n`)
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
    process.exitCode = 1
  }
}

await main()
