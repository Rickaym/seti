import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = import.meta.dirname
const SEAM = 'routeEgressForTests'

/** Every TypeScript file under the server's sources, relative to them. */
const sources = (): string[] =>
  fs
    .readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => file.split(path.sep).join('/'))

/** Test files and the helpers only tests load, which follow the `test-` naming. */
const testOnly = (file: string): boolean => file.endsWith('.test.ts') || path.basename(file).startsWith('test-')

const read = (file: string): string => fs.readFileSync(path.join(SRC, file), 'utf8')

describe("the proxies' test-only route to a fake model host", () => {
  it('is defined in task-proxy.ts and called only from test files and test helpers', () => {
    const users = sources().filter((file) => read(file).includes(SEAM))
    expect(users).toContain('task-proxy.ts')
    expect(users.filter((file) => file !== 'task-proxy.ts' && !testOnly(file))).toEqual([])
  })

  it('reads no setting, variable or request: task-proxy.ts only stores what a caller hands it', () => {
    const proxy = read('task-proxy.ts')
    const seam = proxy.slice(proxy.indexOf(`export function ${SEAM}`))
    const body = seam.slice(0, seam.indexOf('\n}\n'))
    expect(body).not.toMatch(/process\.env|codexSettings|sandboxPolicy|nodeLink|askInTime/)
    expect(body.trim().split('\n').slice(1)).toEqual(['  testEgress = egress'])
  })

  it('is reached by no file a real install runs: no source but a test or helper imports a test helper', () => {
    const importsHelper = /from '\.{1,2}\/(?:[\w-]+\/)*test-[\w-]+\.js'/
    const importers = sources().filter((file) => !testOnly(file) && importsHelper.test(read(file)))
    expect(importers).toEqual([])
  })
})
