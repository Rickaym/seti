import path from 'node:path'
import { CODEX_MODEL_HOST, hostMatches } from '@seti/shared'
import { holdsBuild, platformOf, programIn } from './codex-fetch.js'
import { CODEX_PIN } from './codex-pin.js'
import { CODEX_ROOT, DATABASE_URL } from './config.js'
import { runQuiet, within, type Check } from './doctor.js'
import { connect } from './pg.js'
import { doctorProbes } from './store/doctor.js'

const SECTION = 'Codex'
const DB_TIMEOUT_MS = 5000
const RUNTIMES = 'Settings, Runtimes'

/** The program new Codex agents start: Seti's copy, checked against the pin, or the user's own. */
async function programCheck(program: string | null): Promise<Check> {
  const pinned = CODEX_PIN.version
  if (program !== null) {
    const version = (await runQuiet(program, ['--version'])).stdout.split(' ').at(-1) ?? ''
    if (version === pinned) {
      return { section: SECTION, state: 'ok', label: `Codex ${pinned}, the program you named at ${program}` }
    }
    const label = `the program you named at ${program} reports ${version === '' ? 'nothing' : version}, not ${pinned}`
    return { section: SECTION, state: 'warn', label, fix: `${RUNTIMES}: clear Own program to use Seti's copy` }
  }
  const copy = programIn(CODEX_ROOT, pinned)
  const build = (() => {
    try {
      return platformOf(CODEX_PIN)
    } catch {
      return null
    }
  })()
  if (build !== null && (await holdsBuild(CODEX_ROOT, pinned, build))) {
    const label = `Codex ${pinned} installed in ${path.dirname(copy)}, checksum verified`
    return { section: SECTION, state: 'ok', label }
  }
  const label = `Codex ${pinned}, the pinned version, is not installed or fails its checksum`
  return { section: SECTION, state: 'warn', label, fix: `${RUNTIMES}: Retry` }
}

/** Codex, only when the user turned it on: the program against the pin, and the OpenAI key. */
export async function doctorCodex(): Promise<Check[]> {
  const pool = connect(DATABASE_URL, 1)
  try {
    const codex = await within(DB_TIMEOUT_MS, doctorProbes.codex(pool))
    if (codex === null) {
      return []
    }
    const keyed = codex.keyHosts.some((hosts) => hosts.some((pattern) => hostMatches(pattern, CODEX_MODEL_HOST)))
    const key: Check = keyed
      ? { section: SECTION, state: 'ok', label: 'the default credential holds an OpenAI key' }
      : {
          section: SECTION,
          state: 'warn',
          label: 'the default credential holds no OpenAI key, so new Codex agents are refused',
          fix: 'Settings, Connections: add your OpenAI key connection to the default credential',
        }
    return [await programCheck(codex.program), key]
  } catch {
    return []
  } finally {
    await pool.end({ timeout: 1 })
  }
}
