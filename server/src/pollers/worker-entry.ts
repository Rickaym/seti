import { tsImport } from 'tsx/esm/api'

// Node strips this file's types itself; the worker's own imports name .js files, which need tsx.
await tsImport('./worker.ts', import.meta.url)
