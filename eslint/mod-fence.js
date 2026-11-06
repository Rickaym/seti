import fs from 'node:fs'
import path from 'node:path'

const SETI = ['@seti/mod-api', 'react', 'lucide-react']

/** @param {string} name */
const escape = (name) => name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/**
 * A mod's own npm dependencies, which its code may import with subpaths and Vite's `?url`.
 * Another part of Seti never counts, whatever the mod's package.json lists.
 * @param {string} dir
 * @returns {string[]}
 */
function ownDependencies(dir) {
  const file = path.join(dir, 'package.json')
  /** @type {unknown} */
  const parsed = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
  const pkg = /** @type {{ dependencies?: Record<string, string> }} */ (parsed)
  return Object.keys(pkg.dependencies ?? {}).filter((name) => !name.startsWith('@seti/') && !SETI.includes(name))
}

/**
 * The imports a mod may not make: anything but the mod API, react, lucide-react, its own
 * dependencies and its own files.
 * @param {string[]} extra
 * @param {string[]} dependencies
 */
function fence(extra, dependencies) {
  const exact = [...SETI, ...extra].map(escape).join('|')
  const own = dependencies.length === 0 ? '' : `|(?:${dependencies.map(escape).join('|')})(?:/[^?]*)?(?:\\?url)?`
  return `^(?!(?:(?:${exact})${own})$)(?!\\./)`
}

/**
 * @param {string[]} files
 * @param {string} regex
 * @param {string} message
 * @returns {import('eslint').Linter.Config}
 */
const restrict = (files, regex, message) => ({
  files,
  rules: { 'no-restricted-imports': ['error', { patterns: [{ regex, message }] }] },
})

/**
 * One fence per mod in `mods/`, so each mod reaches Seti only through @seti/mod-api.
 * @param {URL} modsDir
 */
export function modFences(modsDir) {
  const root = modsDir.pathname
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap(({ name }) => {
      const dependencies = ownDependencies(path.join(root, name))
      return [
        restrict(
          [`mods/${name}/**/*.{ts,tsx}`],
          fence([], dependencies),
          'A mod reaches Seti only through @seti/mod-api, with react, lucide-react, its own dependencies and files.',
        ),
        restrict(
          [`mods/${name}/**/*.test.ts`],
          fence(['vitest'], dependencies),
          'A mod test reaches Seti only through @seti/mod-api, with vitest and its own files.',
        ),
        restrict(
          [`mods/${name}/vitest.config.ts`],
          fence(['@seti/mod-api/vitest'], dependencies),
          'A mod test config re-exports modTestConfig from @seti/mod-api/vitest.',
        ),
      ]
    })
}
