import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../../', import.meta.url))
const TEST_ONLY = /^runtimes\/(?:scripted\/|conformance\/|[\w-]+\/conformance-)/
const IMPORTS_TEST_ONLY = /from '[^']*\/(?:scripted\/|conformance\/|conformance-)[^']*'/

const isTest = (file: string) => /\.test\.tsx?$/.test(file)

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      return sources(full)
    }
    return /\.tsx?$/.test(entry.name) && !isTest(entry.name) ? [full] : []
  })
}

describe("ISO-1: the scripted adapter, the suite and adapters' suite glue are test-only", () => {
  it('no production module imports them, so no install can select the scripted runtime', () => {
    const production = sources(SRC).filter((file) => {
      const relative = path.relative(SRC, file).split(path.sep).join('/')
      return !TEST_ONLY.test(relative)
    })
    expect(production.length).toBeGreaterThan(100)
    const importing = production.filter((file) => IMPORTS_TEST_ONLY.test(readFileSync(file, 'utf8')))
    expect(importing).toEqual([])
  })

  it('the registry names Claude only', () => {
    const registry = readFileSync(path.join(SRC, 'runtimes/registry.ts'), 'utf8')
    expect(registry).toMatch(/const ADAPTERS = \{ claude: claudeAdapter \}/)
  })
})
