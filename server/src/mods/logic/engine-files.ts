import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MOD_LIMITS } from '@seti/shared'
import type { SandboxEntry } from '../../script-sandbox.js'

/** What the runner child is told at start: where each engine package's entry is, and its line cap. */
export interface RunnerConfig {
  modules: Record<string, string>
  lineBytes: number
}

const ENGINE_PACKAGES = ['quickjs-emscripten-core', '@jitl/quickjs-wasmfile-release-sync']
const here = (file: string) => fileURLToPath(new URL(file, import.meta.url))
const SOURCES = [here('./runner.ts'), here('./prelude.ts'), here('../../quickjs/engine.ts')]

interface PackageFiles {
  name: string
  root: string
  entry: string
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
}

/** The folder of the package that holds a file, found by the nearest package.json named `name`. */
function rootOf(file: string, name: string): string {
  for (let dir = path.dirname(file); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const manifest = path.join(dir, 'package.json')
    if (fs.existsSync(manifest) && readJson(manifest).name === name) {
      return dir
    }
  }
  throw new Error(`The QuickJS package ${name} has no package.json above ${file}`)
}

/** The ES module a package exports at its root, read from its exports map. */
function esmEntry(root: string): string {
  const { exports } = readJson(path.join(root, 'package.json')) as { exports?: Record<string, unknown> }
  const dot = exports?.['.']
  const file = typeof dot === 'object' && dot !== null && 'import' in dot ? dot.import : undefined
  if (typeof file !== 'string') {
    throw new Error(`The package in ${root} exports no ES module`)
  }
  return path.join(root, file)
}

/** A dependency as Node finds it from the package's own folder, by its real path. */
function dependencyRoot(from: string, name: string): string {
  for (let dir = from; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name)
    if (path.basename(dir) !== 'node_modules' && fs.existsSync(candidate)) {
      return fs.realpathSync(candidate)
    }
  }
  throw new Error(`The QuickJS dependency ${name} is not installed`)
}

/** The engine packages and everything they import, each by the real folder Node loads it from. */
function enginePackages(): PackageFiles[] {
  const found = new Map<string, PackageFiles>()
  const visit = (name: string, root: string) => {
    if (found.has(name)) {
      return
    }
    found.set(name, { name, root, entry: esmEntry(root) })
    const { dependencies } = readJson(path.join(root, 'package.json')) as { dependencies?: Record<string, string> }
    for (const dependency of Object.keys(dependencies ?? {})) {
      visit(dependency, dependencyRoot(root, dependency))
    }
  }
  const require = createRequire(import.meta.url)
  for (const name of ENGINE_PACKAGES) {
    visit(name, rootOf(require.resolve(name), name))
  }
  return [...found.values()]
}

let cached: { entry: SandboxEntry; config: RunnerConfig } | null = null

/** The runner and the only files it may read: its own sources and the engine's packages. */
export function runnerFiles(): { entry: SandboxEntry; config: RunnerConfig } {
  if (cached === null) {
    const packages = enginePackages()
    const [runner, ...sources] = SOURCES
    const config: RunnerConfig = {
      modules: Object.fromEntries(packages.map((pkg) => [pkg.name, pathToFileURL(pkg.entry).href])),
      lineBytes: MOD_LIMITS.lineBytes,
    }
    cached = {
      entry: { runner: runner ?? '', reads: [...sources, ...packages.map((pkg) => pkg.root)] },
      config,
    }
  }
  return cached
}
