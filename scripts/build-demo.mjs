import { existsSync } from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { build } from 'esbuild'

// Bundles the demo to plain JavaScript in server/dist, so it runs with no transpiler.

const SERVER_MODULES = path.resolve('server/node_modules')

/** @param {string} specifier */
const packageName = (specifier) =>
  specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/')

/** Server dependencies load from node_modules; the rest, shared source included, is bundled. */
const serverPackagesExternal = {
  name: 'server-packages-external',
  /** @param {import('esbuild').PluginBuild} plugin */
  setup(plugin) {
    plugin.onResolve({ filter: /^[^./]/ }, ({ path: specifier }) => {
      const builtin = specifier.startsWith('node:') || builtinModules.includes(specifier)
      const name = packageName(specifier)
      return builtin || (!name.startsWith('@seti/') && existsSync(path.join(SERVER_MODULES, name)))
        ? { external: true }
        : undefined
    })
  },
}

await build({
  entryPoints: ['server/src/demo/main.ts', 'server/src/demo/agent.ts', 'server/src/demo/planner.ts'],
  outdir: 'server/dist',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  plugins: [serverPackagesExternal],
  logLevel: 'warning',
})
