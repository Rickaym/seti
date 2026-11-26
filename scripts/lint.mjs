import { execFileSync, spawn } from 'node:child_process'
import { availableParallelism, totalmem } from 'node:os'
import { dirname } from 'node:path'

// Typed linting keeps every project it opens until exit, so each tsconfig gets its own process.
const ESLINT = 'node_modules/eslint/bin/eslint.js'
const HEAP_MB = 3072
const MAX_JOBS = 4

/**
 * @param {string[]} args
 * @returns {string[]}
 */
function gitFiles(args) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', ...args], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => file !== '')
}

/** @returns {string[]} */
function projectDirs() {
  const dirs = gitFiles([':(glob)**/tsconfig.json'])
    .map((file) => dirname(file))
    .filter((dir) => dir !== '.')
  return dirs.filter((dir) => !dirs.some((outer) => dir.startsWith(`${outer}/`)))
}

/** @returns {number} */
function jobCount() {
  const byMemory = Math.floor(totalmem() / ((HEAP_MB + 1024) * 1024 * 1024))
  return Math.max(1, Math.min(MAX_JOBS, availableParallelism(), byMemory))
}

/**
 * @typedef {{ label: string, targets: string[], size: number }} Project
 */

/** @returns {Project[]} */
function projects() {
  const dirs = projectDirs()
  const files = gitFiles([])
  const inside = (/** @type {string} */ dir) => files.filter((file) => file.startsWith(`${dir}/`)).length
  const sizes = dirs.map(inside)
  const outside = dirs.flatMap((dir) => ['--ignore-pattern', `${dir}/**`])
  const root = { label: '.', targets: ['.', ...outside], size: files.length - sizes.reduce((a, b) => a + b, 0) }
  const nested = dirs.map((dir, index) => ({ label: dir, targets: [dir], size: sizes[index] ?? 0 }))
  return [root, ...nested].sort((a, b) => b.size - a.size)
}

/**
 * Runs ESLint on one project and prints its output in one piece once it ends.
 * @param {Project} project
 * @returns {Promise<number>}
 */
async function eslint(project) {
  const color = process.stdout.isTTY ? ['--color'] : []
  const args = [`--max-old-space-size=${String(HEAP_MB)}`, ESLINT, ...project.targets, '--max-warnings', '0', ...color]
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...args, ...process.argv.slice(2)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    /** @type {Buffer[]} */
    const output = []
    let done = false
    const finish = (/** @type {number} */ status) => {
      if (done) {
        return
      }
      done = true
      process.stdout.write(`${status === 0 ? 'ok' : 'FAILED'}: eslint ${project.label}\n`)
      process.stdout.write(Buffer.concat(output))
      resolve(status)
    }
    child.stdout.on('data', (/** @type {Buffer} */ chunk) => {
      output.push(chunk)
    })
    child.stderr.on('data', (/** @type {Buffer} */ chunk) => {
      output.push(chunk)
    })
    child.on('error', (error) => {
      output.push(Buffer.from(`${error.message}\n`))
      finish(1)
    })
    child.on('close', (code) => {
      finish(code ?? 1)
    })
  })
}

/**
 * @param {Project[]} queue
 * @param {number[]} statuses
 * @returns {Promise<void>}
 */
async function worker(queue, statuses) {
  for (let project = queue.shift(); project; project = queue.shift()) {
    statuses.push(await eslint(project))
  }
}

const queue = projects()
/** @type {number[]} */
const statuses = []
await Promise.all(Array.from({ length: Math.min(jobCount(), queue.length) }, async () => worker(queue, statuses)))
process.exit(Math.max(...statuses))
