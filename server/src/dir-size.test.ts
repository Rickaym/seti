import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { walkSize } from './dir-size.js'
import { parseStatus } from './git-state.js'
import { measureNow, settled } from './size-cache.js'
import { sumSizes } from './storage-overview.js'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dir-size-'))

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
})

function write(file: string, bytes: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'x'.repeat(bytes))
}

describe('folder sizes', () => {
  it('counts every file once, per folder directly inside, and follows no symlink', async () => {
    const dir = path.join(ROOT, 'counted')
    write(path.join(dir, 'top.txt'), 10)
    write(path.join(dir, 'src', 'a.ts'), 100)
    write(path.join(dir, 'src', 'deep', 'b.ts'), 50)
    write(path.join(dir, 'node_modules', 'pkg', 'index.js'), 1000)
    fs.linkSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), path.join(dir, 'node_modules', 'pkg', 'linked.js'))
    write(path.join(ROOT, 'outside', 'big.bin'), 5000)
    fs.symlinkSync(path.join(ROOT, 'outside'), path.join(dir, 'link'))

    const walked = await walkSize(dir)

    expect(walked.size).toEqual({ bytes: 1160, files: 4, capped: false })
    expect(walked.children.get('src')).toEqual({ bytes: 150, files: 2, capped: false })
    expect(walked.children.get('node_modules')).toEqual({ bytes: 1000, files: 1, capped: false })
    expect(walked.children.has('link')).toBe(false)
  })

  it('stops at its entry and time caps and marks what it gave as a floor', async () => {
    const dir = path.join(ROOT, 'capped')
    for (let i = 0; i < 20; i += 1) {
      write(path.join(dir, `d${String(i)}`, 'f.txt'), 10)
    }
    const byEntries = await walkSize(dir, { entries: 5, ms: 60_000 })
    expect(byEntries.size.capped).toBe(true)
    expect(byEntries.size.bytes).toBeLessThan(200)

    let now = 0
    const byTime = await walkSize(dir, { entries: 1_000_000, ms: 10 }, () => (now += 6))
    expect(byTime.size.capped).toBe(true)
    expect([...byTime.children.values()].every((size) => size.capped)).toBe(true)

    expect((await walkSize(dir)).size).toEqual({ bytes: 200, files: 20, capped: false })
  })

  it('keeps the sizes of the folders a walk passed through', async () => {
    const dir = path.join(ROOT, 'cached')
    write(path.join(dir, 'one', 'a.txt'), 7)
    expect(await measureNow(dir)).toMatchObject({ bytes: 7 })
    await settled()
  })

  it('sums sizes, "about" when one is capped or unknown', () => {
    expect(sumSizes([])).toEqual({ bytes: 0, files: 0, capped: false })
    expect(sumSizes([null])).toBeNull()
    expect(sumSizes([{ bytes: 5, files: 1, capped: false }, null])).toEqual({ bytes: 5, files: 1, capped: true })
    expect(
      sumSizes([
        { bytes: 5, files: 1, capped: false },
        { bytes: 2, files: 2, capped: false },
      ]),
    ).toEqual({ bytes: 7, files: 3, capped: false })
  })
})

describe('git badges', () => {
  it('reads the branch, changed files and distance from the upstream', () => {
    const text = ['# branch.oid abc', '# branch.head main', '# branch.ab +2 -1', '1 .M N... a', '? new.txt'].join('\n')
    expect(parseStatus(text)).toEqual({ branch: 'main', dirty: 2, ahead: 2, behind: 1 })
    expect(parseStatus('# branch.head (detached)\n')).toEqual({ branch: null, dirty: 0, ahead: null, behind: null })
  })
})
