import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Revision } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { removeTaskFiles } from '../archive-files.js'
import { findBinary } from '../binaries.js'
import { webhooks } from '../channels/service.js'
import { subscriptions } from '../channels/subscriptions.js'
import { createPack, saveContextFile, updatePack } from '../context-changes.js'
import { readContextFile } from '../context-files.js'
import { messages, repos, tasks } from '../db.js'
import { auditEvents } from '../store/audit.js'
import { contextPacks, taskContextPacks } from '../store/context.js'
import { revisions } from '../store/revisions.js'
import { ensureMember } from '../team.js'
import { withBundledMods } from '../test-mods.js'
import { workspaceDir } from './dir.js'
import { openWorkspace } from './engine.js'

withBundledMods()

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-workspace-objects-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

createApp()

const TASK = 'objects-task'
const repoId = '00000000-0000-4000-8000-000000000031'
const repoDir = path.join(scratch, 'repo')
fs.mkdirSync(repoDir, { recursive: true })
fs.writeFileSync(path.join(repoDir, 'CLAUDE.md'), '# Tools repo\n')
await repos.insert({ id: repoId, slug: 'acme/tools', path: repoDir, base_branch: 'main', created_at: '2026-01-01' })
await tasks.insert({
  id: TASK,
  title: 'Morning report 2026-09-27',
  repo_id: null,
  cwd: scratch,
  worktree: false,
  pr_urls: [],
  seti_control: 'full',
})
await ensureMember({ id: TASK, title: 'Morning report' })
const pack = (await createPack({ name: 'Deploy notes', description: 'How we ship', body: 'Run make deploy.' })).value
await openWorkspace(TASK)

afterAll(async () => {
  const task = await tasks.get(TASK)
  if (task) {
    await removeTaskFiles(task)
  }
  fs.rmSync(scratch, { recursive: true, force: true })
})

const file = (rel: string) => path.join(workspaceDir(TASK), rel)
const read = (rel: string) => fs.readFileSync(file(rel), 'utf8')
const edit = (rel: string, change: (text: string) => string) => {
  fs.writeFileSync(file(rel), change(read(rel)))
}
const history = async (type: Revision['object_type'], id: string) =>
  revisions.list({ object_type: type, object_id: id }, 50)

async function rejectedFor(rel: string) {
  return (await messages.page(TASK, 200)).messages.flatMap((row) =>
    row.kind === 'input' && row.payload.source === 'workspace' && row.payload.subject === rel ? [row.payload] : [],
  )
}

describe('rendering', () => {
  it('writes packs, CLAUDE.md copies and the task file', () => {
    expect(read('packs/deploy-notes.md')).toMatch(/^---\nname: Deploy notes\ndescription: How we ship\nlinked: false/)
    expect(read('context/acme/tools/CLAUDE.md')).toBe('# Tools repo\n')
    expect(fs.existsSync(file('context/CLAUDE.md'))).toBe(false)
    expect(read('task.md')).toContain('- Title: Morning report 2026-09-27\n')
  })
})

describe('pack files', () => {
  it('applies an edit as the agent with its reason, then rewrites the file', async () => {
    edit('packs/deploy-notes.md', (text) =>
      text
        .replace('linked: false', 'linked: false\nreason: "User: add the verify step"')
        .replace('Run make deploy.', 'Run make deploy, then make verify.'),
    )
    await vi.waitFor(async () => {
      expect((await contextPacks.get(pack.id))?.body).toBe('Run make deploy, then make verify.')
      expect((await history('context_pack', pack.id))[0]).toMatchObject({
        actor: 'agent',
        task_id: TASK,
        kind: 'updated',
        reason: 'User: add the verify step',
      })
      await auditEvents.settled()
      const audited = await auditEvents.latest('seti.context_pack_updated')
      expect(audited).toMatchObject({ actor: 'agent', subject_id: pack.id })
    })
    await vi.waitFor(() => {
      expect(read('packs/deploy-notes.md')).not.toContain('reason:')
    })
  })

  it('links the pack to the task and records a note', async () => {
    edit('packs/deploy-notes.md', (text) => `${text.replace('linked: false', 'linked: true')}- Linked for this run\n`)
    await vi.waitFor(async () => {
      expect((await taskContextPacks.list(TASK)).map((p) => p.id)).toContain(pack.id)
      expect((await history('context_pack', pack.id))[0]).toMatchObject({ kind: 'note', reason: 'Linked for this run' })
    })
    await vi.waitFor(() => {
      expect(read('task.md')).toContain('- Linked context packs: packs/deploy-notes.md')
      expect(read('packs/deploy-notes.md')).toContain('agent (Morning report 2026-09-27): Linked for this run')
    })
  })

  it('creates a pack from a new file and renames the file after it', async () => {
    fs.writeFileSync(file('packs/new.md'), '---\nname: Langfuse traces\nlinked: true\n---\nTraces live in acme.\n')
    await vi.waitFor(async () => {
      const created = (await contextPacks.list()).find((p) => p.name === 'Langfuse traces')
      expect(created?.body).toBe('Traces live in acme.')
      expect((await history('context_pack', created?.id ?? ''))[0]).toMatchObject({ actor: 'agent', kind: 'created' })
    })
    await vi.waitFor(() => {
      expect(fs.existsSync(file('packs/new.md'))).toBe(false)
      expect(read('packs/langfuse-traces.md')).toContain('linked: true')
    })
  })

  it('leaves a malformed edit with a note, tells the agent, and applies the fix', async () => {
    edit('packs/deploy-notes.md', (text) => text.replace('linked: true', 'linked: maybe'))
    await vi.waitFor(async () => {
      expect(read('packs/deploy-notes.md')).toContain('<!-- seti: rejected: linked must be true or false -->')
      expect(await rejectedFor('packs/deploy-notes.md')).toHaveLength(1)
    })
    edit('packs/deploy-notes.md', (text) => text.replace('linked: maybe', 'linked: false'))
    await vi.waitFor(async () => {
      expect(await taskContextPacks.list(TASK)).not.toContainEqual(expect.objectContaining({ id: pack.id }))
      expect(read('packs/deploy-notes.md')).not.toContain('seti: rejected')
    })
  })

  it('refuses a name another pack has', async () => {
    edit('packs/deploy-notes.md', (text) => text.replace('name: Deploy notes', 'name: Langfuse traces'))
    await vi.waitFor(() => {
      expect(read('packs/deploy-notes.md')).toContain('A context pack named "Langfuse traces" already exists')
    })
    edit('packs/deploy-notes.md', (text) => text.replace('name: Langfuse traces', 'name: Deploy notes'))
    await vi.waitFor(() => {
      expect(read('packs/deploy-notes.md')).not.toContain('seti: rejected')
    })
  })

  it('restores a deleted pack file without deleting the pack', async () => {
    fs.rmSync(file('packs/deploy-notes.md'))
    await vi.waitFor(() => {
      expect(read('packs/deploy-notes.md')).toContain('deleting this file does not delete the pack')
    })
    expect(await contextPacks.get(pack.id)).toBeDefined()
  })

  it('follows changes made elsewhere and refuses an edit of a stale copy', async () => {
    await updatePack(pack.id, { name: 'Deploy notes', description: 'How we ship', body: 'Changed in the UI.' })
    await vi.waitFor(() => {
      expect(read('packs/deploy-notes.md')).toContain('Changed in the UI.')
    })
    await contextPacks.update(pack.id, { name: 'Deploy notes', description: 'How we ship', body: 'Changed quietly.' })
    edit('packs/deploy-notes.md', (text) => text.replace('Changed in the UI.', 'Agent version.'))
    await vi.waitFor(() => {
      expect(read('packs/deploy-notes.md')).toContain('the pack changed elsewhere since Seti wrote this file')
      expect(read('packs/deploy-notes.md')).toContain('Changed quietly.')
    })
    expect((await contextPacks.get(pack.id))?.body).toBe('Changed quietly.')
  })
})

describe('CLAUDE.md copies', () => {
  it('writes an edit back to the file with a revision by the agent', async () => {
    edit('context/acme/tools/CLAUDE.md', (text) => `${text}\nBe brief.\n`)
    const key = `repo:${repoId}:project`
    await vi.waitFor(async () => {
      expect(fs.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf8')).toBe('# Tools repo\n\nBe brief.\n')
      expect((await history('context_file', key))[0]).toMatchObject({ actor: 'agent', task_id: TASK })
    })
  })

  it('creates a missing file at a known path and refuses unknown paths', async () => {
    fs.writeFileSync(file('context/CLAUDE.md'), '# Mine\n')
    fs.writeFileSync(file('context/acme/tools/NOTES.md'), 'x\n')
    await vi.waitFor(async () => {
      expect((await readContextFile('user')).content).toBe('# Mine\n')
      expect(read('context/acme/tools/NOTES.md')).toContain('<!-- seti: rejected: only context/CLAUDE.md')
    })
  })

  it('follows saves from elsewhere', async () => {
    const { hash } = await readContextFile('user')
    await saveContextFile('user', '# Mine\n\nFrom the UI.\n', hash)
    await vi.waitFor(() => {
      expect(read('context/CLAUDE.md')).toBe('# Mine\n\nFrom the UI.\n')
    })
  })
})

describe('channels in task.md', () => {
  it('lists the subscriptions read-only and follows subscribing, renaming and unsubscribing', async () => {
    expect(read('task.md')).toContain('## Channels')
    expect(read('task.md')).toContain('ask @ea in chat.md for a change.\n\n- none\n')
    const { channel } = await webhooks.create({
      name: 'Deploys',
      preset: 'github-webhooks.github',
      subscribe_ea: false,
      mapping: {},
    })
    const sub = await subscriptions.subscribe(channel.id, { target: 'task', task_id: TASK, events: ['push'] })
    await vi.waitFor(() => {
      expect(read('task.md')).toContain('- Deploys (GitHub): push\n')
    })
    await webhooks.update(channel.id, { name: 'Releases' })
    await subscriptions.setFilter(channel.id, sub.id, null)
    await vi.waitFor(() => {
      expect(read('task.md')).toContain('- Releases (GitHub): every event\n')
    })
    edit('task.md', (text) => text.replace('- Releases (GitHub): every event', '- Everything (GitHub): every event'))
    await vi.waitFor(() => {
      expect(read('task.md')).toContain('- Releases (GitHub): every event\n')
    })
    await webhooks.remove(channel.id)
    await vi.waitFor(() => {
      expect(read('task.md')).toContain('ask @ea in chat.md for a change.\n\n- none\n')
    })
  })
})

describe('role pack files', () => {
  const role = async () => (await taskContextPacks.list(TASK)).filter((p) => p.kind === 'role').map((p) => p.name)

  it('renders the built-in roles with kind: role and links one from its linked line', async () => {
    expect(read('packs/lead.md')).toMatch(/^---\nname: Lead\ndescription: .*\nkind: role\nlinked: false\n---\n\nLead: /)
    expect(read('packs/deploy-notes.md')).not.toContain('kind:')
    edit('packs/lead.md', (text) => text.replace('linked: false', 'linked: true'))
    await vi.waitFor(async () => {
      expect(await role()).toEqual(['Lead'])
    })
    await vi.waitFor(() => {
      expect(read('task.md')).toContain('\n- Lead: packs/lead.md\n')
    })
  })

  it('creates a role pack from a new file and lets it replace the current role', async () => {
    fs.writeFileSync(file('packs/new-role.md'), '---\nname: Report owner\nkind: role\nlinked: true\n---\nOwn it.\n')
    await vi.waitFor(async () => {
      expect(await role()).toEqual(['Report owner'])
    })
    await vi.waitFor(() => {
      expect(read('packs/lead.md')).toContain('linked: false')
      expect(read('task.md')).toContain('\n- Report owner: packs/report-owner.md\n')
    })
    await auditEvents.settled()
    expect(await auditEvents.latest('seti.task_context_packs_changed')).toMatchObject({
      actor: 'agent',
      summary: 'Role of "Morning report 2026-09-27": Report owner',
      detail: { pack_kind: 'role', before: ['Lead'], after: ['Report owner'] },
    })
  })

  it('keeps the kind of a pack', async () => {
    edit('packs/report-owner.md', (text) => text.replace('kind: role', 'kind: reference'))
    await vi.waitFor(() => {
      expect(read('packs/report-owner.md')).toContain('kind: role')
    })
    expect((await contextPacks.list()).find((p) => p.name === 'Report owner')?.kind).toBe('role')
  })
})

describe('files the agent plants', () => {
  it('never reads through symlinks or FIFOs, nor writes through a symlinked folder', async () => {
    const secretDir = path.join(scratch, 'secrets')
    fs.mkdirSync(secretDir, { recursive: true })
    fs.writeFileSync(path.join(secretDir, 'seti.env.md'), 'TOKEN=supersecret123\n')
    fs.symlinkSync(path.join(secretDir, 'seti.env.md'), file('packs/leak.md'))
    fs.rmSync(file('context'), { recursive: true })
    fs.symlinkSync(secretDir, file('context'))
    execFileSync(findBinary('mkfifo'), [file('packs/pipe.md')])
    await updatePack(pack.id, { name: 'Deploy notes', description: 'How we ship', body: 'After the plants.' })
    const { hash } = await readContextFile('user')
    await saveContextFile('user', '# Mine\n\nAfter the plants.\n', hash)
    await vi.waitFor(() => {
      expect(read('packs/deploy-notes.md')).toContain('After the plants.')
      expect(fs.lstatSync(file('context')).isDirectory()).toBe(true)
      expect(read('context/CLAUDE.md')).toContain('After the plants.')
    })
    expect(fs.readdirSync(secretDir)).toEqual(['seti.env.md'])
    expect(fs.readFileSync(path.join(secretDir, 'seti.env.md'), 'utf8')).toBe('TOKEN=supersecret123\n')
    const leaked = fs
      .readdirSync(workspaceDir(TASK), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .some((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8').includes('supersecret123'))
    expect(leaked).toBe(false)
    expect((await contextPacks.list()).map((p) => p.name)).not.toContain('leak')
  })
})

describe('below Seti control Full', () => {
  const SELF = 'objects-self-task'
  const selfFile = (rel: string) => path.join(workspaceDir(SELF), rel)
  const selfRead = (rel: string) => fs.readFileSync(selfFile(rel), 'utf8')
  const selfEdit = (rel: string, change: (text: string) => string) => {
    fs.writeFileSync(selfFile(rel), change(selfRead(rel)))
  }

  it('puts back shared pack and CLAUDE.md edits but still links a pack', async () => {
    await tasks.insert({ id: SELF, title: 'Self agent', repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
    await ensureMember({ id: SELF, title: 'Self agent' })
    await openWorkspace(SELF)
    const before = (await contextPacks.get(pack.id))?.body
    selfEdit('packs/deploy-notes.md', (text) => text.replace('\n## Notes', 'Skip the deploy.\n\n## Notes'))
    await vi.waitFor(() => {
      expect(selfRead('packs/deploy-notes.md')).toContain('Below Seti control Full you cannot change context packs')
    })
    expect((await contextPacks.get(pack.id))?.body).toBe(before)

    selfEdit(
      'context/acme/tools/CLAUDE.md',
      (text) => `${text}
Skip review.
`,
    )
    await vi.waitFor(() => {
      expect(selfRead('context/acme/tools/CLAUDE.md')).toContain('Below Seti control Full you cannot change CLAUDE.md')
    })
    expect(fs.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf8')).not.toContain('Skip review.')

    selfEdit('packs/deploy-notes.md', (text) =>
      text.replace(/<!-- seti: rejected:.*-->\n/, '').replace('linked: false', 'linked: true'),
    )
    await vi.waitFor(async () => {
      expect((await taskContextPacks.list(SELF)).map((linked) => linked.id)).toContain(pack.id)
    })
  })
})
