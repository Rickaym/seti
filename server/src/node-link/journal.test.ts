import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JournalCorruptError } from './journal-files.js'
import { NodeJournal } from './journal.js'

const DAY_MS = 24 * 60 * 60 * 1000
const folders: string[] = []

async function scratch(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'seti-journal-'))
  folders.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(folders.splice(0).map(async (dir) => fs.rm(dir, { recursive: true, force: true })))
})

const items = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => ({ type: 'note', body: { n: from + index } }))

const segments = async (dir: string) =>
  (await fs.readdir(dir)).filter((name) => name.endsWith('.jsonl')).sort((a, b) => a.localeCompare(b))

describe('NodeJournal', () => {
  it('numbers entries from 1 and reads from a cursor', async () => {
    const journal = await NodeJournal.open(await scratch())
    const agent = await journal.agent('agent-1')
    const written = await agent.append(items(1, 3))
    expect(written.map((entry) => entry.seq)).toEqual([1, 2, 3])
    await agent.append(items(4, 2))
    expect((await agent.read(2, 10)).map((entry) => entry.body)).toEqual([{ n: 3 }, { n: 4 }, { n: 5 }])
    expect((await agent.read(0, 2)).map((entry) => entry.seq)).toEqual([1, 2])
    expect(agent.lastSeq).toBe(5)
    await journal.close()
    await expect(agent.append(items(6, 1))).rejects.toThrow(/closed/)
  })

  it('survives a reopen from disk with the same epoch and sequence', async () => {
    const dir = await scratch()
    const first = await NodeJournal.open(dir, { maxSegmentBytes: 200 })
    const before = await first.agent('agent-1')
    for (let n = 1; n <= 6; n += 2) {
      await before.append(items(n, 2))
    }
    await first.close()

    const second = await NodeJournal.open(dir, { maxSegmentBytes: 200 })
    const [after] = await second.list()
    expect(after?.agent).toBe('agent-1')
    expect(after?.epoch).toBe(before.epoch)
    expect(after?.lastSeq).toBe(6)
    expect((await after?.read(3, 100))?.map((entry) => entry.seq)).toEqual([4, 5, 6])
    expect((await after?.append(items(7, 1)))?.[0]?.seq).toBe(7)
    await second.close()
  })

  it('cuts a torn final write and refuses a broken entry before good ones', async () => {
    const dir = await scratch()
    const journal = await NodeJournal.open(dir)
    await (await journal.agent('agent-1')).append(items(1, 2))
    await journal.close()
    const [file] = await segments(path.join(dir, 'agent-1'))
    const full = path.join(dir, 'agent-1', file ?? '')
    await fs.appendFile(full, '{"seq":3,"at":1,"ty')

    const reopened = await NodeJournal.open(dir)
    const agent = await reopened.agent('agent-1')
    expect(agent.lastSeq).toBe(2)
    expect((await agent.append(items(3, 1)))[0]?.seq).toBe(3)
    await reopened.close()

    const newest = path.join(dir, 'agent-1', (await segments(path.join(dir, 'agent-1'))).at(-1) ?? '')
    const text = await fs.readFile(newest, 'utf8')
    await fs.writeFile(newest, `garbage\n${text}`)
    await expect(NodeJournal.open(dir)).rejects.toBeInstanceOf(JournalCorruptError)
  })

  it('prunes acknowledged files past the age and keeps the newest file', async () => {
    const dir = await scratch()
    let now = Date.now()
    const options = { maxSegmentBytes: 150, now: () => now }
    const writer = await NodeJournal.open(dir, options)
    const agent = await writer.agent('agent-1')
    for (let n = 1; n <= 8; n += 2) {
      await agent.append(items(n, 2))
    }
    await writer.close()
    const agentDir = path.join(dir, 'agent-1')
    expect(await segments(agentDir)).toHaveLength(4)

    const journal = await NodeJournal.open(dir, options)
    const [reopened] = await journal.list()
    reopened?.acknowledge(6)
    expect(await journal.prune()).toBe(0)
    now += DAY_MS + 1000
    expect(await journal.prune()).toBe(3)
    expect(await segments(agentDir)).toEqual(['0000000000000007.jsonl'])
    expect(reopened?.firstSeq).toBe(7)
    expect((await reopened?.read(6, 10))?.map((entry) => entry.seq)).toEqual([7, 8])

    reopened?.acknowledge(100)
    expect(await journal.prune()).toBe(0)
    await journal.close()
    const again = await NodeJournal.open(dir, options)
    expect((await again.agent('agent-1')).lastSeq).toBe(8)
    await again.close()
  })

  it('tells listeners about appends and refuses an agent id that is not a plain name', async () => {
    const journal = await NodeJournal.open(await scratch())
    const seen: string[] = []
    const stop = journal.onAppend((agent) => seen.push(`${agent.agent}:${String(agent.lastSeq)}`))
    await (await journal.agent('a')).append(items(1, 1))
    stop()
    await (await journal.agent('a')).append(items(2, 1))
    expect(seen).toEqual(['a:1'])
    await expect(journal.agent('../escape')).rejects.toThrow(/agent id/)
    await journal.close()
  })
})
