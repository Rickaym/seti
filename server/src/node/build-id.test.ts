import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeBuildId } from './build-id.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const NODE_FILE = 'server/src/egress-rules.ts'
const CONTROL_FILE = 'server/src/routes/tasks.ts'

const edited = (file: string, change: (text: string) => string) =>
  new Map([[file, change(fs.readFileSync(path.join(ROOT, file), 'utf8'))]])

describe("the node's build id", () => {
  it('changes with the code the node runs, and not with a comment or a control plane file', async () => {
    const base = await nodeBuildId(ROOT)
    expect(base).toMatch(/^[0-9a-f]{16}$/)
    expect(
      await nodeBuildId(
        ROOT,
        edited(NODE_FILE, (text) => `// a note\n${text}`),
      ),
    ).toBe(base)
    expect(
      await nodeBuildId(
        ROOT,
        edited(CONTROL_FILE, (text) => `${text}\nexport const extra = 1\n`),
      ),
    ).toBe(base)
    expect(
      await nodeBuildId(
        ROOT,
        edited(NODE_FILE, (text) => `${text}\nprocess.exitCode ??= 0\n`),
      ),
    ).not.toBe(base)
  })
})
