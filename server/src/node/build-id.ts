import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { build, type Plugin } from 'esbuild'

const ENTRY = 'server/src/node/main.ts'
const WORKSPACE = /^@seti\/(shared|mod-api)(\/.*)?$/
const PINNED = ['package.json', 'pnpm-lock.yaml', 'server/package.json', 'shared/package.json']

/**
 * Bundles workspace sources and leaves packages to node_modules, which the lockfile pins. Shared
 * modules count as free of side effects, so the ones the node never uses drop out.
 */
function nodeSources(root: string, overrides: ReadonlyMap<string, string>): Plugin {
  const shared = path.join(root, 'shared', 'src') + path.sep
  return {
    name: 'node-sources',
    setup(bundle) {
      bundle.onResolve({ filter: /^[^./]/ }, (args) => {
        const workspace = WORKSPACE.exec(args.path)
        if (workspace === null) {
          return { path: args.path, external: true }
        }
        const dir = workspace[1] === 'shared' ? 'shared/src' : 'packages/mod-api/src'
        return { path: path.join(root, dir, `${workspace[2] ?? '/index'}.ts`), sideEffects: workspace[1] !== 'shared' }
      })
      bundle.onResolve({ filter: /^\./ }, (args) => {
        const resolved = path.resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts'))
        return { path: resolved, sideEffects: !resolved.startsWith(shared) }
      })
      bundle.onLoad({ filter: /\.ts$/ }, (args) => {
        const contents = overrides.get(path.relative(root, args.path))
        return contents === undefined ? undefined : { contents, loader: 'ts' }
      })
    },
  }
}

/**
 * The node's build id: a hash of the code the node runs, as bundled from its entry with comments
 * left out, and of the package files that pin what it loads. A change elsewhere keeps it.
 * `overrides` replaces sources by their path from `root`, for tests.
 */
export async function nodeBuildId(root: string, overrides: ReadonlyMap<string, string> = new Map()): Promise<string> {
  const bundled = await build({
    entryPoints: [path.join(root, ENTRY)],
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    legalComments: 'none',
    logLevel: 'silent',
    plugins: [nodeSources(root, overrides)],
  })
  const hash = createHash('sha256')
  for (const file of bundled.outputFiles) {
    hash.update(file.contents)
  }
  for (const file of PINNED) {
    hash.update(fs.readFileSync(path.join(root, file)))
  }
  return hash.digest('hex').slice(0, 16)
}
