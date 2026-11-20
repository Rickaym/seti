import fs from 'node:fs/promises'
import type { JournalEntry, NodeMessageOf } from '@seti/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OutgoingMessage } from './connection.js'
import type { LinkEvent } from './events.js'
import { JournalReceiver } from './journal-receiver.js'
import { NodeJournal } from './journal.js'
import { LinkPeer } from './link.js'
import { MemoryCursorStore } from './stores.js'
import { linkPeers, scratchDir } from './test-link.js'

const folders: string[] = []
const journals: NodeJournal[] = []

afterEach(async () => {
  await Promise.all(journals.splice(0).map(async (journal) => journal.close()))
  await Promise.all(folders.splice(0).map(async (dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function nodeJournal(): Promise<NodeJournal> {
  const dir = await scratchDir('seti-link-')
  folders.push(dir)
  const journal = await NodeJournal.open(dir)
  journals.push(journal)
  return journal
}

const notes = (count: number) => Array.from({ length: count }, (_, index) => ({ type: 'note', body: { index } }))
const entry = (seq: number): JournalEntry => ({ seq, at: 1, type: 'note', body: seq })
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index)
const seqs = (store: MemoryCursorStore, agent: string) => store.entries(agent).map((stored) => stored.seq)

function batch(first: number, count: number, epoch = 'e1'): NodeMessageOf<'journal.append'> {
  const entries = range(first, first + count - 1).map(entry)
  return { v: 1, type: 'journal.append', id: `b${String(first)}`, agent: 'a', epoch, first, entries }
}

describe('JournalReceiver', () => {
  it('stores in order, acknowledges duplicates and refuses gaps and other epochs', async () => {
    const store = new MemoryCursorStore()
    const events: LinkEvent[] = []
    const receiver = new JournalReceiver(store, (event) => events.push(event))
    const replies: OutgoingMessage[] = []
    const reply = (message: OutgoingMessage) => replies.push(message)

    await receiver.receive(batch(1, 3), reply)
    await receiver.receive(batch(1, 3), reply)
    await receiver.receive(batch(2, 4), reply)
    await receiver.receive(batch(9, 1), reply)
    await receiver.receive(batch(6, 1, 'e2'), reply)

    expect(seqs(store, 'a')).toEqual([1, 2, 3, 4, 5])
    expect(replies).toEqual([
      { type: 'journal.ack', agent: 'a', epoch: 'e1', seq: 3 },
      { type: 'journal.ack', agent: 'a', epoch: 'e1', seq: 3 },
      { type: 'journal.ack', agent: 'a', epoch: 'e1', seq: 5 },
      { type: 'journal.reject', agent: 'a', reason: 'gap', first: 9, cursor: { epoch: 'e1', seq: 5 } },
      { type: 'journal.reject', agent: 'a', reason: 'epoch', first: 6, cursor: { epoch: 'e1', seq: 5 } },
    ])
    expect(events).toEqual([{ type: 'journal-stopped', agent: 'a', reason: 'epoch' }])
  })

  it('fails the batch, and acknowledges nothing, when the store fails', async () => {
    const store = new MemoryCursorStore()
    vi.spyOn(store, 'commit').mockRejectedValueOnce(new Error('disk full'))
    const replies: OutgoingMessage[] = []
    const receiver = new JournalReceiver(store, () => undefined)
    await expect(receiver.receive(batch(1, 2), (message) => replies.push(message))).rejects.toThrow('disk full')
    await receiver.receive(batch(1, 2), (message) => replies.push(message))
    expect(replies).toEqual([{ type: 'journal.ack', agent: 'a', epoch: 'e1', seq: 2 }])
  })
})

describe('journal over a link', () => {
  it('delivers every entry once and in order through a small window', async () => {
    const journal = await nodeJournal()
    const agent = await journal.agent('agent-1')
    await agent.append(notes(40))
    const store = new MemoryCursorStore()
    const node = new LinkPeer({ journal, journalOptions: { window: 2, batchEntries: 3 }, pingMs: 0 })
    const control = new LinkPeer({ cursors: store, pingMs: 0 })
    await linkPeers(node, control)
    await agent.append(notes(5))
    await vi.waitFor(() => {
      expect(seqs(store, 'agent-1')).toEqual(range(1, 45))
    })
    expect(await store.read('agent-1')).toEqual({ epoch: agent.epoch, seq: 45 })
  })

  it('replays from the cursor after a gap', async () => {
    const journal = await nodeJournal()
    const agent = await journal.agent('agent-1')
    await agent.append(notes(12))
    const store = new MemoryCursorStore()
    const node = new LinkPeer({ journal, journalOptions: { batchEntries: 4 }, pingMs: 0 })
    const control = new LinkPeer({ cursors: store, pingMs: 0 })
    await linkPeers(node, control, async () => Promise.resolve({ 'agent-1': { epoch: agent.epoch, seq: 6 } }))
    await vi.waitFor(() => {
      expect(seqs(store, 'agent-1')).toEqual(range(1, 12))
    })
  })

  it('ignores duplicates the node sends again', async () => {
    const journal = await nodeJournal()
    const agent = await journal.agent('agent-1')
    const store = new MemoryCursorStore()
    await store.commit('agent-1', agent.epoch, await agent.append(notes(5)))
    await agent.append(notes(3))
    const node = new LinkPeer({ journal, journalOptions: { batchEntries: 2 }, pingMs: 0 })
    const control = new LinkPeer({ cursors: store, pingMs: 0 })
    await linkPeers(node, control)
    await vi.waitFor(() => {
      expect(seqs(store, 'agent-1')).toEqual(range(1, 8))
    })
  })

  it('refuses a journal from another epoch and never merges it', async () => {
    const journal = await nodeJournal()
    const agent = await journal.agent('agent-1')
    await agent.append(notes(3))
    const store = new MemoryCursorStore()
    await store.commit('agent-1', 'an-older-epoch', [entry(1)])
    const nodeEvents: LinkEvent[] = []
    const node = new LinkPeer({ journal, pingMs: 0, onEvent: (event) => nodeEvents.push(event) })
    const control = new LinkPeer({ cursors: store, pingMs: 0 })
    await linkPeers(node, control, async () => store.list('node-a'))
    await vi.waitFor(() => {
      expect(nodeEvents).toContainEqual({ type: 'journal-stopped', agent: 'agent-1', reason: 'epoch' })
    })
    expect(store.entries('agent-1')).toEqual([entry(1)])
  })

  it('replays after the connection drops mid-stream, each entry exactly once', async () => {
    const journal = await nodeJournal()
    const agent = await journal.agent('agent-1')
    const other = await journal.agent('agent-2')
    await agent.append(notes(30))
    await other.append(notes(4))
    const store = new MemoryCursorStore()
    const commit = store.commit.bind(store)
    let commits = 0
    let linked: Awaited<ReturnType<typeof linkPeers>> | null = null
    vi.spyOn(store, 'commit').mockImplementation(async (...args) => {
      commits += 1
      if (commits === 3) {
        linked?.drop()
      }
      return commit(...args)
    })
    const node = new LinkPeer({ journal, journalOptions: { window: 4, batchEntries: 3 }, pingMs: 0 })
    const control = new LinkPeer({ cursors: store, pingMs: 0 })
    linked = await linkPeers(node, control, async () => store.list('node-a'))
    await linked.nodeClosed
    expect(node.connected).toBe(false)
    expect(seqs(store, 'agent-1').length).toBeLessThan(30)
    await agent.append(notes(5))

    await linkPeers(node, control, async () => store.list('node-a'))
    await vi.waitFor(() => {
      expect(seqs(store, 'agent-1')).toEqual(range(1, 35))
      expect(seqs(store, 'agent-2')).toEqual(range(1, 4))
    })
  })
})
