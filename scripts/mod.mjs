import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SDK = path.join(ROOT, 'packages/mod-api')
const TEMPLATE = path.join(SDK, 'template')
const CWD = process.env.INIT_CWD ?? process.cwd()

const USAGE = `Usage:
  pnpm mod new <id>      make a mod from the template in ./<id>
  pnpm mod build [path]  bundle src/logic.ts into logic.js
  pnpm mod test [path]   build, then run the mod's tests against a fake Seti
  pnpm mod check [path]  validate the package as Seti will and print its consent copy
  pnpm mod dev <path>    load the folder into the local Seti as a dev mod`

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

/**
 * @param {string} file
 * @param {string[]} args
 * @param {string} cwd
 */
function run(file, args, cwd) {
  const result = spawnSync(file, args, { cwd, stdio: 'inherit' })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

/** @param {string} id */
function create(id) {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) {
    fail('A mod id is lowercase words joined by -, such as linear-issues')
  }
  const target = path.join(CWD, id)
  if (fs.existsSync(target)) {
    fail(`${target} exists already`)
  }
  fs.cpSync(TEMPLATE, target, { recursive: true })
  const name = id
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
  for (const file of fs.readdirSync(target, { recursive: true, encoding: 'utf8' })) {
    const full = path.join(target, file)
    if (fs.statSync(full).isFile()) {
      const text = fs.readFileSync(full, 'utf8')
      fs.writeFileSync(
        full,
        text.replaceAll('__ID__', id).replaceAll('__NAME__', name).replaceAll('__SDK__', `link:${SDK}`),
      )
    }
  }
  process.stdout.write(`Made ${target}. Next: cd ${id} && pnpm install && pnpm mod test\n`)
}

/** Refuses node: and bare imports, so the bundle runs in Seti's sandbox with nothing to load. */
const noNode = {
  name: 'no-node',
  /** @param {import('esbuild').PluginBuild} b */
  setup(b) {
    b.onResolve({ filter: /^node:/ }, (args) => ({ errors: [{ text: `${args.path} does not exist inside Seti` }] }))
  },
}

/** @param {string} dir */
async function bundle(dir) {
  await build({
    entryPoints: [path.join(dir, 'src/logic.ts')],
    outfile: path.join(dir, 'logic.js'),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2023',
    minifyWhitespace: true,
    alias: { '@seti/mod-api/logic': path.join(SDK, 'src/logic.ts') },
    plugins: [noNode],
    logLevel: 'warning',
  })
}

const [command, arg] = process.argv.slice(2)
const dir = path.resolve(CWD, arg ?? '.')
switch (command) {
  case 'new':
    create(arg ?? fail(USAGE))
    break
  case 'build':
    await bundle(dir)
    break
  case 'test':
    await bundle(dir)
    run('npx', ['vitest', 'run'], dir)
    break
  case 'check':
  case 'dev':
    run('pnpm', ['--silent', '--filter', '@seti/server', 'mod', command, dir], ROOT)
    break
  case undefined:
  default:
    fail(USAGE)
}
