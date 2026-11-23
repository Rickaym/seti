import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { memoryPath } from './memory-files.js'
import { lineCounts, memoryChanges, snapshotMemory } from './memory-snapshot.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-memory-snapshot-test-'))

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function folder(name: string, files: Record<string, string | Buffer>): string {
  const dir = path.join(root, name)
  for (const [file, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), data)
  }
  return dir
}

describe('snapshotMemory', () => {
  it('reads text files in nested folders, leaving out links, binary files and the lock', async () => {
    const dir = folder('mixed', {
      'MEMORY.md': '- a\n',
      'topics/b.md': 'b\n',
      'image.png': Buffer.from([0x89, 0, 1]),
      '.consolidate-lock': '4242',
    })
    fs.symlinkSync('/etc/hostname', path.join(dir, 'link.md'))
    const result = await snapshotMemory(dir)
    expect(result.ok && [...result.files.keys()]).toEqual(['MEMORY.md', 'topics/b.md'])
  })

  it('treats a missing folder as empty', async () => {
    const result = await snapshotMemory(path.join(root, 'none'))
    expect(result.ok && result.files.size).toBe(0)
  })

  it('refuses a folder over the file or size limit, or one that is a link', async () => {
    const dir = folder('big', { 'a.md': 'x'.repeat(600), 'b.md': 'y' })
    expect(await snapshotMemory(dir, { bytes: 500, files: 10 })).toMatchObject({ ok: false })
    expect(await snapshotMemory(dir, { bytes: 5000, files: 1 })).toMatchObject({ ok: false })
    fs.symlinkSync(dir, path.join(root, 'linked'))
    expect(await snapshotMemory(path.join(root, 'linked'))).toMatchObject({ ok: false })
  })
})

describe('memoryChanges', () => {
  it('lists changed, created and deleted files in path order', () => {
    const file = (text: string) => ({ text, sha256: text })
    const before = new Map([
      ['a.md', file('1')],
      ['b.md', file('2')],
      ['c.md', file('3')],
    ])
    const after = new Map([
      ['a.md', file('1')],
      ['b.md', file('22')],
      ['d.md', file('4')],
    ])
    expect(memoryChanges(before, after).map((c) => [c.file, c.before?.text ?? null, c.after?.text ?? null])).toEqual([
      ['b.md', '2', '22'],
      ['c.md', '3', null],
      ['d.md', null, '4'],
    ])
  })

  it('counts lines added and removed', () => {
    expect(lineCounts('a\nb\nb\n', 'b\nc\n')).toEqual({ added: 1, removed: 2 })
    expect(lineCounts('', 'a')).toEqual({ added: 1, removed: 0 })
  })
})

describe('memoryPath', () => {
  it('refuses paths that leave the folder or pass a link', async () => {
    const dir = folder('paths', { 'MEMORY.md': '' })
    fs.symlinkSync(root, path.join(dir, 'up'))
    expect(await memoryPath(dir, 'MEMORY.md')).toBe(path.join(dir, 'MEMORY.md'))
    expect(await memoryPath(dir, 'new/topic.md')).toBe(path.join(dir, 'new/topic.md'))
    for (const bad of ['../x.md', '/etc/passwd', 'a//b', './a', 'up/x.md', '']) {
      expect(await memoryPath(dir, bad)).toBeNull()
    }
  })
})
