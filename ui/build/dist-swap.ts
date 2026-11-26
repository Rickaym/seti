import fs from 'node:fs'
import path from 'node:path'

/** One build's id and the hashed files it named, relative to the build folder. */
export interface BuildRecord {
  id: string
  assets: string[]
}

/** Lists the builds whose hashed files the served folder holds, newest first. */
export const BUILDS_FILE = 'builds.json'

/** Older builds whose hashed files stay served, so a page opened on one can load until it updates. */
const KEPT_BUILDS = 2

const ASSETS = 'assets'

/** The build that swaps in, then the newest older ones to keep, each once. */
export function keptBuilds(current: BuildRecord, previous: readonly BuildRecord[]): BuildRecord[] {
  const older = previous.filter((record) => record.id !== current.id)
  return [current, ...older.slice(0, KEPT_BUILDS)]
}

const isRecord = (value: unknown): value is BuildRecord =>
  typeof value === 'object' &&
  value !== null &&
  'id' in value &&
  typeof value.id === 'string' &&
  'assets' in value &&
  Array.isArray(value.assets) &&
  value.assets.every((asset) => typeof asset === 'string')

const listAssets = (dir: string): string[] =>
  fs.existsSync(path.join(dir, ASSETS)) ? fs.readdirSync(path.join(dir, ASSETS)).map((name) => `${ASSETS}/${name}`) : []

/** The builds a served folder holds; a folder from before this list counts as one unnamed build. */
export function readBuilds(dir: string): BuildRecord[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, BUILDS_FILE), 'utf8'))
    return Array.isArray(parsed) ? parsed.filter(isRecord) : []
  } catch {
    const assets = listAssets(dir)
    return assets.length > 0 ? [{ id: 'unnamed', assets }] : []
  }
}

/** Copies the kept older builds' hashed files from the served folder into the staged one. */
function carryAssets(kept: readonly BuildRecord[], live: string, staged: string): BuildRecord[] {
  return kept.map((record, index) => {
    if (index === 0) {
      return record
    }
    const assets = record.assets.filter((asset) => {
      const from = path.join(live, asset)
      const to = path.join(staged, asset)
      if (!fs.existsSync(to) && fs.existsSync(from)) {
        fs.copyFileSync(from, to)
      }
      return fs.existsSync(to)
    })
    return { id: record.id, assets }
  })
}

interface SwapInput {
  /** The finished build, outside the served folder. */
  staged: string
  /** The served folder, such as ui/dist. */
  live: string
  /** Where the served folder goes for the moment between the two renames. */
  retired: string
  /** The finished build's id. */
  id: string
}

/**
 * Puts a finished build in place of the served folder with two renames, so a reader never sees a
 * half-written folder, and keeps the hashed files of the newest older builds beside it.
 */
export function swapIn({ staged, live, retired, id }: SwapInput): void {
  const current = { id, assets: listAssets(staged) }
  fs.mkdirSync(path.join(staged, ASSETS), { recursive: true })
  const kept = carryAssets(keptBuilds(current, readBuilds(live)), live, staged)
  fs.writeFileSync(path.join(staged, BUILDS_FILE), `${JSON.stringify(kept, null, 2)}\n`)
  fs.rmSync(retired, { recursive: true, force: true })
  if (fs.existsSync(live)) {
    fs.renameSync(live, retired)
  }
  fs.renameSync(staged, live)
  fs.rmSync(retired, { recursive: true, force: true })
}

/** Names the build in index.html, where the server and the running page both read it. */
export function tagBuild(html: string, id: string): string {
  const tag = `<meta name="seti-build" content="${id}" />`
  const tagged = html.replace(/<meta charset="UTF-8" \/>/i, (charset) => `${charset}\n    ${tag}`)
  if (tagged === html) {
    throw new Error('index.html lost its charset tag, so the build id has no place')
  }
  return tagged
}
