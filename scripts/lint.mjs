import { execFileSync, spawnSync } from 'node:child_process'
import { dirname } from 'node:path'

// Typed linting keeps every project it opens until exit, so each tsconfig gets its own process.
const ESLINT = 'node_modules/eslint/bin/eslint.js'
const HEAP_MB = 3072

/** @returns {string[]} */
function projectDirs() {
  const dirs = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', ':(glob)**/tsconfig.json'],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter((file) => file !== '')
    .map((file) => dirname(file))
    .filter((dir) => dir !== '.')
  return dirs.filter((dir) => !dirs.some((outer) => dir.startsWith(`${outer}/`)))
}

/**
 * @param {string[]} targets
 * @returns {number}
 */
function eslint(targets) {
  const args = [`--max-old-space-size=${String(HEAP_MB)}`, ESLINT, ...targets, '--max-warnings', '0']
  const run = spawnSync(process.execPath, [...args, ...process.argv.slice(2)], { stdio: 'inherit' })
  return run.status ?? 1
}

const dirs = projectDirs()
const outside = dirs.flatMap((dir) => ['--ignore-pattern', `${dir}/**`])
const statuses = [eslint(['.', ...outside]), ...dirs.map((dir) => eslint([dir]))]
process.exit(Math.max(...statuses))
