import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { resolvePaths } from './resolve-paths.js'

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seti-resolve-')))
const real = path.join(base, 'real-work')
const work = path.join(base, 'work')
const outside = path.join(base, 'outside')
fs.mkdirSync(path.join(real, 'src'), { recursive: true })
fs.mkdirSync(outside)
fs.writeFileSync(path.join(outside, 'key'), 'k')
fs.symlinkSync(real, work)
fs.symlinkSync(path.join(outside, 'key'), path.join(real, 'key'))
fs.symlinkSync(outside, path.join(real, 'linked'))
fs.symlinkSync(path.join(real, 'loop-b'), path.join(real, 'loop-a'))
fs.symlinkSync(path.join(real, 'loop-a'), path.join(real, 'loop-b'))

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe('where the paths a call names lead on disk', () => {
  it('follows a link below a working directory, to a file or into a directory', async () => {
    const named = [path.join(work, 'key'), path.join(work, 'linked/new.txt')]
    const resolved = await resolvePaths(named, [work])
    expect(Object.fromEntries(resolved)).toEqual({
      [path.join(work, 'key')]: path.join(outside, 'key'),
      [path.join(work, 'linked/new.txt')]: path.join(outside, 'new.txt'),
    })
  })

  it('leaves out paths that lead where they say, a linked working directory included', async () => {
    const named = [path.join(work, 'src'), path.join(work, 'src/missing/deeper.ts'), outside]
    expect((await resolvePaths(named, [work])).size).toBe(0)
  })

  it('says a path leads nowhere known when its links loop', async () => {
    const loop = path.join(work, 'loop-a')
    expect((await resolvePaths([loop], [work])).get(loop)).toBeNull()
  })
})
