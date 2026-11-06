import fs from 'node:fs'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { auditQuery, type AuditActor, type AuditKind, type AuditQuery } from '@seti/shared'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { audit, auditPrLink } from './audit.js'
import { sql } from './db.js'
import { auditEvents, eventHash, type NewAuditEvent } from './store/audit.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-audit-store-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  return root
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

const clear = async () => {
  await sql`DELETE FROM audit_event`
  await sql`DELETE FROM audit_chain`
}

beforeEach(clear)

const event = (kind: AuditKind, actor: AuditActor, summary: string, at = new Date().toISOString()): NewAuditEvent => ({
  at,
  actor,
  kind,
  subject_type: 'task',
  subject_id: null,
  summary,
  detail: {},
})

async function seed(count: number): Promise<number[]> {
  const ids: number[] = []
  for (let i = 0; i < count; i++) {
    ids.push(await auditEvents.insert(event('repo.added', 'user', `repo ${String(i)}`)))
  }
  return ids
}

const page = async (query: Partial<AuditQuery> = {}) => auditEvents.page(auditQuery.parse(query))

describe('audit event store', () => {
  it('pages newest first with a before cursor', async () => {
    const ids = await seed(5)
    const first = await page({ limit: 2 })
    expect(first.events.map((e) => e.id)).toEqual([ids[4], ids[3]])
    expect(first.next_before).toBe(ids[3])
    const second = await page({ limit: 2, before: first.next_before ?? undefined })
    expect(second.events.map((e) => e.id)).toEqual([ids[2], ids[1]])
    const last = await page({ limit: 2, before: second.next_before ?? undefined })
    expect(last.events.map((e) => e.id)).toEqual([ids[0]])
    expect(last.next_before).toBeNull()
  })

  it('filters by area prefix, exact kind, actor and search text', async () => {
    await auditEvents.insert(event('task.created', 'user', 'Created task "alpha"'))
    await auditEvents.insert(event('task.deleted', 'user', 'Deleted task "beta"'))
    await auditEvents.insert(event('system.channel_changed', 'system', 'Changed reminder "nightly"'))
    await auditEvents.insert(event('agent.outward', 'agent', 'Bash: git push origin 100%_done'))

    expect((await page({ kind: 'task' })).events.map((e) => e.kind)).toEqual(['task.deleted', 'task.created'])
    expect((await page({ kind: 'task.created' })).events).toHaveLength(1)
    expect((await page({ actor: 'system' })).events.map((e) => e.kind)).toEqual(['system.channel_changed'])
    expect((await page({ q: 'beta' })).events.map((e) => e.kind)).toEqual(['task.deleted'])
    expect((await page({ q: 'outward' })).events.map((e) => e.kind)).toEqual(['agent.outward'])
    expect((await page({ q: '%_' })).events.map((e) => e.kind)).toEqual(['agent.outward'])
    expect((await page({ q: '_x' })).events).toEqual([])
    expect((await page({ kind: 'task', actor: 'agent' })).events).toEqual([])
  })

  it('does not let one area match another that shares its prefix', async () => {
    await auditEvents.insert(event('task.created', 'user', 'a'))
    expect((await page({ kind: 'agent' })).events).toEqual([])
  })

  it('caps the limit at 200', () => {
    expect(auditQuery.safeParse({ limit: '201' }).success).toBe(false)
    expect(auditQuery.parse({}).limit).toBe(50)
  })

  it('prunes events older than the retention period, a year by default', async () => {
    const now = new Date('2026-06-01T00:00:00Z')
    await auditEvents.insert(event('repo.added', 'user', 'last year', '2025-05-01T00:00:00.000Z'))
    await auditEvents.insert(event('repo.added', 'user', 'old', '2026-03-01T00:00:00.000Z'))
    await auditEvents.insert(event('repo.added', 'user', 'recent', '2026-03-10T00:00:00.000Z'))
    await audit.prune(now)
    expect((await page()).events.map((e) => e.summary)).toEqual(['recent', 'old'])
    await audit.prune(now, 90)
    expect((await page()).events.map((e) => e.summary)).toEqual(['recent'])
  })

  it('never throws into the caller when recording fails', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const insert = vi.spyOn(auditEvents, 'insert').mockRejectedValue(new Error('disk full'))
    await expect(
      audit.record({ actor: 'user', kind: 'repo.added', subject_type: 'repo', summary: 'x' }),
    ).resolves.toBeUndefined()
    expect(write).toHaveBeenCalledWith(expect.stringContaining('disk full'))
    insert.mockRestore()
    write.mockRestore()
  })

  it('scrubs summaries and detail before storing', async () => {
    await audit.record({
      actor: 'user',
      kind: 'mcp.server_added',
      subject_type: 'mcp_server',
      summary: 'Added with token=abc123',
      detail: { note: 'Bearer abcdef123456' },
    })
    const [stored] = (await page()).events
    expect(stored?.summary).toBe('Added with token=[redacted]')
    expect(stored?.detail).toEqual({ note: 'Bearer [redacted]' })
  })
})

describe('agent events', () => {
  const assistant = (blocks: unknown[]) =>
    ({ type: 'assistant', message: { content: blocks } }) as unknown as SDKMessage

  it('records only the tool calls the runner flagged as outward, scrubbed', async () => {
    const m = assistant([
      { type: 'text', text: 'pushing' },
      {
        type: 'tool_use',
        id: 'a',
        name: 'Bash',
        input: { command: 'git push https://x:ghp_abcdefghijkl@github.com/o/r' },
      },
      { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'ls' } },
      {
        type: 'tool_use',
        id: 'c',
        name: 'mcp__plugin_slack_slack__slack_send_message',
        input: { channel_id: 'C0123ABC', text: 'hi\nthere xoxb-1234-5678-abcdefgh' },
      },
    ])
    await audit.outwardCalls('task-1', m, ['a', 'c'])
    const events = (await page({ kind: 'agent' })).events
    expect(events.map((e) => [e.actor, e.subject_id, e.summary])).toEqual([
      ['agent', 'task-1', 'Slack send_message \u2192 C0123ABC: "hi there [redacted]"'],
      ['agent', 'task-1', 'Bash: git push https://[redacted]@github.com/o/r'],
    ])
    expect(events[0]?.detail).toEqual({
      tool: 'mcp__plugin_slack_slack__slack_send_message',
      tool_use_id: 'c',
      target: 'C0123ABC',
      text: 'hi\nthere [redacted]',
    })
    expect(events[1]?.detail).toMatchObject({ text: 'git push https://[redacted]@github.com/o/r' })
    expect((await auditEvents.verify()).ok).toBe(true)
  })

  it('keeps old outward rows and new ones with the sent input on one intact chain', async () => {
    await auditEvents.insert({ ...event('agent.outward', 'agent', 'mcp__slack__send_message'), detail: { tool: 'x' } })
    const m = assistant([
      { type: 'tool_use', id: 'd', name: 'mcp__x__post_update', input: { body: 'a\n'.repeat(400) } },
    ])
    await audit.outwardCalls('task-2', m, ['d'])
    const [latest] = (await page({ kind: 'agent.outward' })).events
    expect(latest?.detail.text).toBe('a\n'.repeat(400))
    expect(await auditEvents.verify()).toMatchObject({ ok: true, checked: 2 })
  })

  it('records PR links and unlinks with the PR URL', async () => {
    const url = 'https://github.com/acme/app/pull/12'
    await auditPrLink({ actor: 'agent', taskId: 't', url, linked: true })
    await auditPrLink({ actor: 'user', taskId: 't', url, linked: false })
    expect((await page()).events.map((e) => [e.kind, e.actor, e.summary, e.detail.url])).toEqual([
      ['task.pr_unlinked', 'user', 'Unlinked PR acme/app#12', url],
      ['task.pr_linked', 'agent', 'Linked PR acme/app#12', url],
    ])
  })
})

describe('audit hash chain', () => {
  const edit = async (query: string, ...params: (string | number)[]) => sql.unsafe(query, params)

  it('links every event to the one before it', async () => {
    const ids = await seed(4)
    const status = await auditEvents.verify()
    expect(status).toMatchObject({ ok: true, checked: 4, head_id: ids[3], broken_at: null, problem: null })
    const rows = await sql<{ prev_hash: string; hash: string }[]>`SELECT prev_hash, hash FROM audit_event ORDER BY id`
    expect(rows[0]?.prev_hash).toBe('0'.repeat(64))
    expect(rows[1]?.prev_hash).toBe(rows[0]?.hash)
    expect(status.head_hash).toBe(rows[3]?.hash)
  })

  it('finds an event whose content changed', async () => {
    const ids = await seed(3)
    await edit('UPDATE audit_event SET summary = $1 WHERE id = $2', 'nothing happened', ids[1] ?? 0)
    expect(await auditEvents.verify()).toMatchObject({
      ok: false,
      checked: 1,
      broken_at: ids[1],
      problem: `Event #${String(ids[1])} was changed after it was recorded`,
    })
  })

  it('finds a removed event in the middle and at the end', async () => {
    const ids = await seed(4)
    await edit('DELETE FROM audit_event WHERE id = $1', ids[1] ?? 0)
    expect(await auditEvents.verify()).toMatchObject({ ok: false, broken_at: ids[2] })
    await clear()
    const again = await seed(3)
    await edit('DELETE FROM audit_event WHERE id = $1', again[2] ?? 0)
    expect(await auditEvents.verify()).toMatchObject({
      ok: false,
      broken_at: again[2],
      problem: `The newest events do not match the recorded head #${String(again[2])}`,
    })
  })

  it('finds a rewrite that recomputed the hashes but not the recorded head', async () => {
    const ids = await seed(2)
    const last = ids[1] ?? 0
    await edit('UPDATE audit_event SET summary = $1 WHERE id = $2', 'nothing happened', last)
    const [row] = await sql<(NewAuditEvent & { id: number; detail: string; prev_hash: string })[]>`SELECT *
      FROM audit_event WHERE id = ${last}`
    expect(row).toBeDefined()
    if (row) {
      await edit('UPDATE audit_event SET hash = $1 WHERE id = $2', eventHash(row, row.prev_hash), last)
    }
    expect(await auditEvents.verify()).toMatchObject({
      ok: false,
      broken_at: last,
      problem: `The newest events do not match the recorded head #${String(last)}`,
    })
  })

  it('stays intact across pruning', async () => {
    await auditEvents.insert(event('repo.added', 'user', 'old', '2026-01-01T00:00:00.000Z'))
    await auditEvents.insert(event('repo.added', 'user', 'older too', '2026-01-02T00:00:00.000Z'))
    await auditEvents.insert(event('repo.added', 'user', 'recent', '2026-05-30T00:00:00.000Z'))
    await audit.prune(new Date('2026-06-01T00:00:00Z'), 30)
    expect((await page()).events.map((e) => e.summary)).toEqual(['recent'])
    expect(await auditEvents.verify()).toMatchObject({ ok: true, checked: 1 })
    await auditEvents.insert(event('repo.added', 'user', 'newest'))
    expect(await auditEvents.verify()).toMatchObject({ ok: true, checked: 2 })
  })

  it('seals events written without a hash, by a migration or an older Seti', async () => {
    await seed(2)
    for (const summary of ['from an older version', 'also older']) {
      await sql`INSERT INTO audit_event (at, actor, kind, subject_type, subject_id, summary, detail)
        VALUES (${new Date().toISOString()}, 'user', 'repo.added', 'repo', NULL, ${summary}, '{}')`
    }
    expect((await auditEvents.verify()).ok).toBe(false)
    await auditEvents.sealPending()
    expect(await auditEvents.verify()).toMatchObject({ ok: true, checked: 4 })
  })

  it('keeps every event of concurrent writers in the chain, in the order they were recorded', async () => {
    const ids = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => auditEvents.insert(event('repo.added', 'user', `n ${String(i)}`))),
    )
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
    expect(await auditEvents.verify()).toMatchObject({ ok: true, checked: 20, head_id: ids.at(-1) })
  })

  it('writes the head to the journal each day and flags a broken chain', async () => {
    const ids = await seed(2)
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    await audit.checkChain()
    const head = (await auditEvents.verify()).head_hash
    expect(stdout).toHaveBeenCalledWith(`audit: chain head #${String(ids[1])} ${head}\n`)
    expect(stderr).not.toHaveBeenCalled()
    await edit('UPDATE audit_event SET summary = $1 WHERE id = $2', 'edited', ids[0] ?? 0)
    await audit.checkChain()
    expect(stderr).toHaveBeenCalledWith(
      `audit: chain broken at #${String(ids[0])}: Event #${String(ids[0])} was changed after it was recorded\n`,
    )
    stdout.mockRestore()
    stderr.mockRestore()
  })
})
