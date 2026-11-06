/// <reference types="vitest/config" />
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin, type Rolldown } from 'vite'
import { HASHED_PREFIX, type Precache } from './sw/precache'

const SW_SOURCE = path.resolve(import.meta.dirname, 'sw/sw.ts')
const SW_FILE = 'sw.js'
const PRECACHE_PLACEHOLDER = /(["'`])__SETI_PRECACHE__\1/

/** Viewer libraries the precache leaves out; they load from the network when a viewer first opens. */
const ON_DEMAND_MODULE = /[\\/]node_modules[\\/](?:\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?mermaid[\\/]/
const ON_DEMAND_ASSET = /^assets\/sheet-worker-[\w-]+\.js$/

/** Chunks only an on-demand library reaches, and the on-demand worker files. */
function onDemandFiles(bundle: Rolldown.OutputBundle): Set<string> {
  const chunks = Object.values(bundle).filter((file): file is Rolldown.OutputChunk => file.type === 'chunk')
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]))
  const app = new Set<string>()
  const queue = chunks.filter((chunk) => chunk.isEntry)
  for (let chunk = queue.pop(); chunk !== undefined; chunk = queue.pop()) {
    if (app.has(chunk.fileName) || ON_DEMAND_MODULE.test(chunk.facadeModuleId ?? '')) {
      continue
    }
    app.add(chunk.fileName)
    for (const name of [...chunk.imports, ...chunk.dynamicImports]) {
      const next = byName.get(name)
      if (next !== undefined) {
        queue.push(next)
      }
    }
  }
  const lazy = chunks.filter((chunk) => !app.has(chunk.fileName)).map((chunk) => chunk.fileName)
  return new Set([...lazy, ...Object.keys(bundle).filter((name) => ON_DEMAND_ASSET.test(name))])
}

/** Entry chunks with their static imports and stylesheets: the files the first page loads. */
function initialFiles(bundle: Rolldown.OutputBundle): Set<string> {
  const chunks = new Map(
    Object.values(bundle)
      .filter((file): file is Rolldown.OutputChunk => file.type === 'chunk')
      .map((chunk) => [chunk.fileName, chunk]),
  )
  const initial = new Set<string>()
  const queue = [...chunks.values()].filter((chunk) => chunk.isEntry && chunk.fileName !== SW_FILE)
  for (let chunk = queue.pop(); chunk !== undefined; chunk = queue.pop()) {
    if (initial.has(chunk.fileName)) {
      continue
    }
    initial.add(chunk.fileName)
    for (const css of chunk.viteMetadata?.importedCss ?? []) {
      initial.add(css)
    }
    for (const name of chunk.imports) {
      const next = chunks.get(name)
      if (next !== undefined) {
        queue.push(next)
      }
    }
  }
  return initial
}

function builtFiles(dir: string, skip: ReadonlySet<string>): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .filter((file) => file !== SW_FILE && !file.endsWith('.map') && !skip.has(file))
    .sort((a, b) => a.localeCompare(b))
}

/** Emits sw.js at the root of the build with the built files and their content hash baked in. */
function serviceWorker(): Plugin {
  let outDir = ''
  let onDemand = new Set<string>()
  let initial = new Set<string>()
  let emitted = new Set<string>()
  return {
    name: 'seti-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    buildStart() {
      this.emitFile({ type: 'chunk', id: SW_SOURCE, fileName: SW_FILE })
    },
    generateBundle(_options, bundle) {
      onDemand = onDemandFiles(bundle)
      initial = initialFiles(bundle)
      emitted = new Set(Object.keys(bundle))
    },
    writeBundle() {
      const files = builtFiles(outDir, onDemand)
      const assets = files.filter((file) => `/${file}`.startsWith(HASHED_PREFIX))
      const unhashed = assets.filter((file) => !emitted.has(file))
      if (unhashed.length > 0) {
        throw new Error(`${HASHED_PREFIX} holds files the build did not name: ${unhashed.join(', ')}`)
      }
      const hash = createHash('sha256')
      for (const file of files) {
        hash.update(file).update(fs.readFileSync(path.join(outDir, file)))
      }
      const precache: Precache = {
        version: hash.digest('hex').slice(0, 16),
        urls: files.map((file) => `/${file}`),
        lazy: assets.filter((file) => !initial.has(file)).map((file) => `/${file}`),
      }
      const swPath = path.join(outDir, SW_FILE)
      const code = fs.readFileSync(swPath, 'utf8')
      if (!PRECACHE_PLACEHOLDER.test(code)) {
        throw new Error(`${SW_FILE} lost its precache placeholder`)
      }
      fs.writeFileSync(
        swPath,
        code.replace(PRECACHE_PLACEHOLDER, () => JSON.stringify(JSON.stringify(precache))),
      )
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorker()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3006' },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    // pnpm test runs packages in parallel; the default cache at the workspace root is shared.
    fsModuleCachePath: 'node_modules/.vitest-cache',
  },
})
