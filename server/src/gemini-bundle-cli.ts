import fs from 'node:fs'
import path from 'node:path'
import { fetchGemini, geminiPinSchema } from './gemini-fetch.js'
import pin from './runtimes/gemini/pin.json' with { type: 'json' }

/** Leaves a failed fetch for a person to look at, but drops its tarball so a retry starts over. */
const dropTarball = async (dir: string) => fs.promises.rm(path.join(dir, 'gemini-cli.tgz'), { force: true })

/** Fetches the pinned Gemini CLI into `<folder>/<version>/bundle` as Seti does; prints its entry. */
async function main(): Promise<void> {
  const folder = process.argv[2]
  if (folder === undefined || folder === '') {
    process.stderr.write('usage: pnpm --silent --filter @seti/server run gemini-bundle <folder>\n')
    process.exitCode = 1
    return
  }
  try {
    const root = path.resolve(folder)
    const { entry } = await fetchGemini({ pin: geminiPinSchema.parse(pin), root, discard: dropTarball })
    process.stdout.write(`${entry}\n`)
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
    process.exitCode = 1
  }
}

await main()
