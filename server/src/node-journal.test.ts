import { journalAppend, type JournalAppend, type JournalEntry, type JournalReply } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { JournalInbox } from './node-inbox.js'
import { JournalOutbox } from './node-outbox.js'

const AGENT = 'task-1'
const note = (n: number): JournalEntry => ({ type: 'note', error: `n${String(n)}` })
const flushed = async () => new Promise((resolve) => setImmediate(resolve))

async function settled(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await flushed()
  }
}

function only(frames: JournalAppend[]): JournalAppend {
  const [frame, ...rest] = frames.splice(0)
  if (frame === undefined || rest.length > 0) {
    throw new Error(`expected one frame, got ${String(rest.length + (frame === undefined ? 0 : 1))}`)
  }
  return frame
}

/** A node and a control plane joined by a link the test drives frame by frame. */
function link(window = 64) {
  const sent: JournalAppend[] = []
  const replies: JournalReply[] = []
  const applied: string[] = []
  const outbox = new JournalOutbox((frame) => sent.push(journalAppend.parse(frame)), window)
  const inbox = new JournalInbox(
    async (agent, entry) => {
      applied.push(`${agent}:${entry.type === 'note' ? entry.error : entry.type}`)
      await flushed()
    },
    (reply) => replies.push(reply),
  )
  const deliverReplies = () => {
    for (const reply of replies.splice(0)) {
      outbox.reply(reply)
    }
  }
  return { sent, replies, applied, outbox, inbox, deliverReplies }
}

describe('node journal', () => {
  it('applies each entry once and in order, and acknowledges it once applied', async () => {
    const { sent, replies, applied, outbox, inbox } = link()
    outbox.append(AGENT, note(1))
    outbox.append(AGENT, note(2))
    expect(sent.map((frame) => frame.first)).toEqual([1, 2])
    sent.forEach((frame) => {
      inbox.receive(frame)
    })
    await settled()
    expect(applied).toEqual(['task-1:n1', 'task-1:n2'])
    expect(replies.map((reply) => (reply.type === 'journal.ack' ? reply.seq : -1))).toEqual([1, 2])
  })

  it('applies a repeated run once', async () => {
    const { sent, applied, outbox, inbox } = link()
    outbox.append(AGENT, note(1))
    const frame = only(sent)
    inbox.receive(frame)
    inbox.receive(frame)
    inbox.receive({ ...frame })
    await settled()
    expect(applied).toEqual(['task-1:n1'])
  })

  it('holds entries that arrive ahead of a gap until the gap fills', async () => {
    const { sent, applied, outbox, inbox } = link()
    outbox.append(AGENT, note(1))
    outbox.append(AGENT, note(2))
    outbox.append(AGENT, note(3))
    const [one, two, three] = sent
    if (one === undefined || two === undefined || three === undefined) {
      throw new Error('nothing sent')
    }
    inbox.receive(three)
    inbox.receive(two)
    await settled()
    expect(applied).toEqual([])
    inbox.receive(one)
    await settled()
    expect(applied).toEqual(['task-1:n1', 'task-1:n2', 'task-1:n3'])
  })

  it('sends what a dropped link lost again once it is back, and nothing it already stored', async () => {
    const { sent, applied, outbox, inbox, deliverReplies } = link()
    outbox.append(AGENT, note(1))
    inbox.receive(only(sent))
    await settled()
    deliverReplies()
    outbox.append(AGENT, note(2))
    sent.splice(0)
    outbox.disconnected()
    outbox.append(AGENT, note(3))
    expect(sent).toEqual([])
    outbox.resume(inbox.positions())
    expect(sent.map((frame) => [frame.first, frame.entries.length])).toEqual([[2, 2]])
    sent.forEach((frame) => {
      inbox.receive(frame)
    })
    await settled()
    expect(applied).toEqual(['task-1:n1', 'task-1:n2', 'task-1:n3'])
  })

  it('keeps at most a window of entries unacknowledged on the link', async () => {
    const { sent, outbox, inbox, deliverReplies } = link(2)
    for (let n = 1; n <= 5; n += 1) {
      outbox.append(AGENT, note(n))
    }
    expect(sent.map((frame) => frame.first)).toEqual([1, 2])
    sent.splice(0).forEach((frame) => {
      inbox.receive(frame)
    })
    await settled()
    deliverReplies()
    expect(sent.map((frame) => [frame.first, frame.entries.length])).toEqual([
      [3, 1],
      [4, 1],
    ])
  })

  it('refuses a run of a journal it does not know, unless the journal starts anew', async () => {
    const { applied, inbox, replies } = link()
    inbox.receive({ type: 'journal.append', agent: AGENT, epoch: 'a', first: 1, entries: [note(1)] })
    inbox.receive({ type: 'journal.append', agent: AGENT, epoch: 'b', first: 4, entries: [note(4)] })
    inbox.receive({ type: 'journal.append', agent: AGENT, epoch: 'c', first: 1, entries: [note(9)] })
    await settled()
    expect(applied).toEqual(['task-1:n1', 'task-1:n9'])
    expect(replies.filter((reply) => reply.type === 'journal.reject').map((reply) => reply.epoch)).toEqual(['b'])
  })

  it('refuses an old copy of a journal at hello, and the node stops sending for that agent', async () => {
    const { sent, outbox, inbox, deliverReplies } = link()
    outbox.append(AGENT, note(1))
    outbox.append(AGENT, note(2))
    sent.splice(0).forEach((frame) => {
      inbox.receive(frame)
    })
    await settled()
    const [position] = outbox.positions()
    if (position === undefined) {
      throw new Error('no position')
    }
    expect(inbox.hello(position)).toBe(true)
    expect(inbox.hello({ ...position, last: 1 })).toBe(false)
    deliverReplies()
    expect(outbox.refusal(AGENT)).toMatch(/older/)
    outbox.append(AGENT, note(3))
    expect(sent).toEqual([])
  })
  it('lets a restarted control plane take up where the node was acknowledged', async () => {
    const { sent, applied, outbox, inbox, deliverReplies } = link()
    outbox.append(AGENT, note(1))
    inbox.receive(only(sent))
    await settled()
    deliverReplies()
    outbox.disconnected()
    outbox.append(AGENT, note(2))
    const restarted = new JournalInbox(
      async (agent, entry) => {
        applied.push(`${agent}:${entry.type === 'note' ? entry.error : entry.type}`)
        await flushed()
      },
      () => undefined,
    )
    expect(outbox.positions().every((position) => restarted.hello(position))).toBe(true)
    outbox.resume(restarted.positions())
    restarted.receive(only(sent))
    await settled()
    expect(applied).toEqual(['task-1:n1', 'task-1:n2'])
  })

  it('keeps each cursor before acknowledging, so a restart never applies an entry twice', async () => {
    const { sent, applied, outbox } = link()
    const kept: { agent: string; epoch: string; seq: number }[] = []
    const apply = async (agent: string, entry: JournalEntry) => {
      applied.push(`${agent}:${entry.type === 'note' ? entry.error : entry.type}`)
      await flushed()
    }
    const first = new JournalInbox(
      apply,
      () => undefined,
      async (cursor) => {
        kept.push(cursor)
        await flushed()
      },
    )
    outbox.append(AGENT, note(1))
    first.receive(only(sent))
    await settled()
    expect(kept).toEqual([{ agent: AGENT, epoch: outbox.positions()[0]?.epoch, seq: 1 }])
    outbox.disconnected()
    outbox.append(AGENT, note(2))
    const restarted = new JournalInbox(apply, () => undefined)
    restarted.restore(kept)
    expect(outbox.positions().every((position) => restarted.hello(position))).toBe(true)
    outbox.resume(restarted.positions())
    restarted.receive(only(sent))
    await settled()
    expect(applied).toEqual(['task-1:n1', 'task-1:n2'])
  })

  it('lets the node wait until the control plane stored every entry before it stops', async () => {
    const { sent, outbox, inbox, deliverReplies } = link()
    let drained = false
    outbox.append(AGENT, note(1))
    outbox.append(AGENT, note(2))
    void outbox.drained().then(() => {
      drained = true
    })
    for (const frame of sent.splice(0)) {
      inbox.receive(frame)
    }
    await settled()
    expect(drained).toBe(false)
    deliverReplies()
    await settled()
    expect(drained).toBe(true)
  })
})
