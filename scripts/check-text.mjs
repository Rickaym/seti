import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'

const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.md', '.yml', '.yaml', '.css', '.html'])
const SKIP = new Set(['pnpm-lock.yaml'])
const NON_ASCII = /[^\x20-\x7E\t\n\r]/
const YAML_COMMENT = /^\s*#/

/** @returns {string[]} */
function trackedFiles() {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
    .split('\n')
    .filter((file) => file !== '' && existsSync(file))
}

/**
 * @param {string} file
 * @returns {string[]}
 */
function problemsIn(file) {
  const isYaml = /\.ya?ml$/.test(file)
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line, index) => {
      const where = `${file}:${String(index + 1)}`
      const found = []
      const match = NON_ASCII.exec(line)
      if (match) {
        found.push(`${where}: non-ASCII character ${JSON.stringify(match[0])}`)
      }
      if (isYaml && YAML_COMMENT.test(line)) {
        found.push(`${where}: comments are not allowed in YAML`)
      }
      return found
    })
}

const files = process.argv.length > 2 ? process.argv.slice(2) : trackedFiles()
const problems = files
  .filter((file) => !SKIP.has(basename(file)) && TEXT_EXTENSIONS.has(extname(file)))
  .flatMap((file) => problemsIn(file))

if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
