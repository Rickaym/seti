import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** A word that starts like 1.2.3, as `--version` prints it among other words. */
const VERSION = /^\d+\.\d+\.\d/

/** The last version read per program, by the file's change time and size. */
const known = new Map<string, { key: string; version: string | null }>()

/**
 * The version a program reports with `--version`, or null when it is not there or does not run.
 * It runs once per change of the file, never through a shell.
 */
export async function programVersion(program: string): Promise<string | null> {
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(program)
  } catch {
    return null
  }
  const key = `${String(stat.mtimeMs)}:${String(stat.size)}`
  const seen = known.get(program)
  if (seen?.key === key) {
    return seen.version
  }
  const { stdout } = await run(program, ['--version'], { timeout: 10_000 }).catch(() => ({ stdout: '' }))
  const version = stdout.split(/\s+/).find((word) => VERSION.test(word)) ?? null
  known.set(program, { key, version })
  return version
}

/** Reads every program's version afresh next time, as when the user retries a failed one. */
export const forgetVersions = (): void => {
  known.clear()
}
