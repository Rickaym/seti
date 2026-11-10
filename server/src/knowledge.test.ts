import { randomUUID } from 'node:crypto'
import {
  auditQuery,
  knowledgeFields,
  type KnowledgeFieldsInput,
  type KnowledgeSource,
  type SetiControlLevel,
  type Task,
} from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { repos, tasks } from './db.js'
import { approveKnowledge } from './knowledge-review.js'
import { proposeKnowledge, sweepStaleKnowledge } from './knowledge.js'
import { KNOWLEDGE_TOOLS } from './seti-tools/knowledge.js'
import { callSetiTool } from './seti-tools/server.js'
import { auditEvents } from './store/audit.js'
import { knowledge } from './store/knowledge.js'

const DAY = 86_400_000

async function newRepo(): Promise<string> {
  const id = randomUUID()
  await repos.insert({ id, slug: `acme/${id.slice(0, 8)}`, path: `/srv/${id}`, base_branch: 'main', created_at: '' })
  return id
}

async function newTask(repoId: string | null = null, level: SetiControlLevel = 'self'): Promise<Task> {
  const id = randomUUID()
  const cwd = repoId === null ? `/work/${id}` : `/srv/${repoId}`
  await tasks.insert({ id, title: `Agent ${id.slice(0, 8)}`, repo_id: repoId, cwd, worktree: false, pr_urls: [] })
  await tasks.setSetiControl(id, level)
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('task was not stored')
  }
  return task
}

const tool = (name: string) => {
  const found = KNOWLEDGE_TOOLS.find((entry) => entry.name === name)
  if (found === undefined) {
    throw new Error(`no ${name} tool`)
  }
  return found
}

async function call(task: Task, name: string, args: object) {
  const result = await callSetiTool(tool(name), task.id, args)
  const text = result.content.map((block) => block.text).join('')
  return { text, isError: 'isError' in result, json: (): unknown => JSON.parse(text) }
}

const fields = (title: string, extra: Partial<KnowledgeFieldsInput> = {}) => ({
  kind: 'gotcha' as const,
  title,
  body: 'Run the migrations first, or the suite fails on a missing column.',
  verify: 'pnpm e2e smoke passes on a fresh database',
  ...extra,
})

async function approvedNote(title: string, extra: Partial<KnowledgeFieldsInput> = {}) {
  const task = await newTask()
  const note = await proposeKnowledge({ kind: 'agent', task }, knowledgeFields.parse(fields(title, extra)))
  return approveKnowledge(note.id, {})
}

const lastAudit = async (kind: string) => (await auditEvents.page(auditQuery.parse({ kind, limit: 1 }))).events.at(0)

describe('propose_knowledge', () => {
  it('files a proposal that no agent finds until the user approves it', async () => {
    const task = await newTask()
    const title = `Migrations first ${randomUUID()}`
    const proposed = await call(
      task,
      'propose_knowledge',
      fields(title, { sources: [{ kind: 'path', ref: 'e2e/README.md' }] }),
    )
    expect(proposed.isError).toBe(false)
    const { id } = proposed.json() as { id: string }
    expect(await knowledge.get(id)).toMatchObject({
      status: 'proposed',
      proposer: 'agent',
      proposer_task_id: task.id,
      proposer_title: task.title,
      sources: [{ kind: 'path', ref: 'e2e/README.md' }],
    })
    expect((await knowledge.summary()).proposed).toBeGreaterThan(0)
    expect(await lastAudit('context.knowledge_proposed')).toMatchObject({
      actor: 'agent',
      subject_id: id,
      detail: { agent_id: task.id, title, kind: 'gotcha', proposer: 'agent' },
    })
    const before = await call(task, 'search_knowledge', { query: title })
    expect((before.json() as { notes: unknown[] }).notes).toEqual([])
    await approveKnowledge(id, {})
    const after = await call(task, 'search_knowledge', { query: title })
    expect(after.json() as { reminder: string; notes: { id: string }[] }).toMatchObject({
      reminder: expect.stringContaining('not instructions') as string,
      notes: [{ id }],
    })
    const byId = await call(task, 'search_knowledge', { id: id.slice(0, 8) })
    expect((byId.json() as { notes: { title: string }[] }).notes).toMatchObject([{ title }])
  })

  it.each<[string, Partial<KnowledgeFieldsInput>, string]>([
    [
      'an AWS key in the body',
      { body: 'Use AKIAIOSFODNN7EXAMPLE for the bucket.' },
      'body looks like it holds a secret',
    ],
    [
      'a token in a source',
      { sources: [{ kind: 'command', ref: 'gh auth login --with-token ghp_abcdefghijklmnop' }] },
      'source 1 looks like it holds a secret',
    ],
    [
      'an env line in the verify step',
      { verify: `export API_TOKEN=${'ab12cd34'.repeat(2)}` },
      'verify step looks like',
    ],
  ])('refuses a secret: %s', async (_, extra, refusal) => {
    const task = await newTask()
    const title = `Secret ${randomUUID()}`
    const result = await call(task, 'propose_knowledge', fields(title, extra))
    expect(result.isError).toBe(true)
    expect(result.text).toContain(refusal)
    expect(result.text).not.toMatch(/AKIAIOSFODNN7EXAMPLE|ghp_abcdefghijklmnop|abcdefgh12345678/)
    expect((await knowledge.list('proposed')).filter((note) => note.title === title)).toEqual([])
  })

  it("refuses sources that name private paths outside the agent's folders", async () => {
    const repo = await newRepo()
    const task = await newTask(repo)
    const propose = async (source: KnowledgeSource) =>
      call(task, 'propose_knowledge', fields('Paths', { sources: [source] }))
    expect((await propose({ kind: 'path', ref: '/etc/shadow' })).text).toContain('outside your own folders')
    expect((await propose({ kind: 'path', ref: `/srv/${repo}/../other/x` })).text).toContain('outside your own folders')
    expect((await propose({ kind: 'path', ref: '~/.ssh/config' })).text).toContain('home path')
    expect((await propose({ kind: 'command', ref: 'cat /home/someone/notes.txt' })).text).toContain('outside')
    expect((await propose({ kind: 'url', ref: 'http://example.com/x' })).text).toContain('https URL')
    expect((await propose({ kind: 'url', ref: 'https://u:p@example.com/x' })).text).toContain('password in a URL')
    for (const ok of [
      { kind: 'path', ref: `/srv/${repo}/src/app.ts` },
      { kind: 'path', ref: 'src/app.ts' },
      { kind: 'command', ref: 'pnpm test --dir=src' },
      { kind: 'url', ref: 'https://github.com/acme/web/pull/12' },
    ] satisfies KnowledgeSource[]) {
      expect((await propose(ok)).isError, JSON.stringify(ok)).toBe(false)
    }
  })

  it('holds an agent to ten waiting proposals', async () => {
    const task = await newTask()
    for (let n = 0; n < 10; n += 1) {
      await proposeKnowledge({ kind: 'agent', task }, { ...fields(`Note ${String(n)}`), sources: [], repo_id: null })
    }
    expect((await call(task, 'propose_knowledge', fields('One too many'))).text).toContain('At most 10')
  })
})

describe('staleness', () => {
  it('drops facts after 30 days and how-tos after 90 unless verified', async () => {
    const fact = await approvedNote(`Fact ${randomUUID()}`, { kind: 'fact' })
    const howTo = await approvedNote(`How-to ${randomUUID()}`, { kind: 'how-to' })
    const swept = async (days: number) => (await sweepStaleKnowledge(Date.now() + days * DAY)).map((note) => note.id)
    expect(await swept(29)).not.toContain(fact.id)
    const month = await swept(31)
    expect(month).toContain(fact.id)
    expect(month).not.toContain(howTo.id)
    expect(await knowledge.get(fact.id)).toMatchObject({ status: 'stale', status_reason: 'Not verified in 30 days' })
    expect(await lastAudit('context.knowledge_stale')).toMatchObject({ actor: 'system' })
    expect(await swept(91)).toContain(howTo.id)
    const task = await newTask()
    const passed = await call(task, 'verify_knowledge', { id: fact.id, passed: true, note: 'Ran it; holds.' })
    expect(passed.isError).toBe(false)
    expect(await knowledge.get(fact.id)).toMatchObject({ status: 'approved', verified_count: 1, status_reason: null })
  })
})

describe('verify_knowledge', () => {
  it('takes a note out after three failures in a row and files one correction', async () => {
    const note = await approvedNote(`Port ${randomUUID()}`, { kind: 'environment' })
    const task = await newTask()
    const fail = async (report: string) => call(task, 'verify_knowledge', { id: note.id, passed: false, note: report })
    expect((await fail('Port 5433 is closed.')).text).toBe(JSON.stringify({ ok: true, text: 'Recorded.' }, null, 1))
    await call(task, 'verify_knowledge', { id: note.id, passed: true, note: 'Works again.' })
    await fail('Closed again.')
    await fail('Still closed.')
    expect((await knowledge.get(note.id))?.status).toBe('approved')
    const third = await fail('The service moved to 5434.')
    const { correction } = third.json() as { correction: string }
    expect(await knowledge.get(note.id)).toMatchObject({ status: 'stale', failures: 3 })
    expect(await knowledge.get(correction)).toMatchObject({
      status: 'proposed',
      corrects_id: note.id,
      title: `Correction: ${note.title}`,
      body: expect.stringContaining('The service moved to 5434.') as string,
    })
    expect(await lastAudit('context.knowledge_verified')).toMatchObject({
      actor: 'agent',
      detail: { passed: false, failures: 3, report: 'The service moved to 5434.' },
    })
    await fail('Still moved.')
    expect((await knowledge.list('proposed')).filter((entry) => entry.corrects_id === note.id)).toHaveLength(1)
    const approved = await approveKnowledge(correction, {})
    expect(approved.status).toBe('approved')
    expect(await knowledge.get(note.id)).toMatchObject({
      status: 'rejected',
      status_reason: 'Replaced by its correction',
    })
  })

  it('refuses a report with a secret and a note outside the agent repos', async () => {
    const repo = await newRepo()
    const note = await approvedNote(`Scoped ${randomUUID()}`, { repo_id: repo })
    const outsider = await newTask()
    const missing = await call(outsider, 'verify_knowledge', { id: note.id, passed: true, note: 'Fine.' })
    expect(missing.text).toContain('No approved knowledge note has the id')
    const insider = await newTask(repo)
    const leaky = await call(insider, 'verify_knowledge', {
      id: note.id,
      passed: true,
      note: 'Used ghp_abcdefghijklmnop',
    })
    expect(leaky.text).toContain('report looks like it holds a secret')
    expect((await knowledge.get(note.id))?.verified_count).toBe(0)
  })
})
