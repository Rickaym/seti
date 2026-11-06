import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { removeTaskFiles } from '../archive-files.js'
import { createPack } from '../context-changes.js'
import { messages, tasks } from '../db.js'
import { inputPreface } from '../inputs.js'
import { endSession, runTurn } from '../runner.js'
import { sandboxMounts, type SandboxLayout } from '../sandbox-mounts.js'
import { sessionOptions } from '../session-options.js'
import { auditEvents } from '../store/audit.js'
import { revisions } from '../store/revisions.js'
import { teamMembers, teamMessages, USER_READER } from '../store/team.js'
import { ensureMember, postTeamMessage, updateMember } from '../team.js'
import { waitIdle } from '../wait-idle.js'
import { workspaceDir, WORKSPACE_ENV } from './dir.js'
import { openWorkspace } from './engine.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-workspace-chat-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

/** Fake agents append `say` to chat.md and apply `edit` to a pack file, as file tools would. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeAssistant, fakeResult } = await import('../fake-sdk.js')
  const nodeFs = await import('node:fs')
  const nodePath = await import('node:path')
  const say = new Map<string, string>()
  const edit = new Map<string, { file: string; from: string; to: string }>()
  const fake = new FakeSdk(function* ({ session }) {
    const env = session.options.env ?? {}
    const dir = env.SETI_WORKSPACE ?? ''
    const text = say.get(env.SETI_TASK_ID ?? '')
    if (text !== undefined) {
      nodeFs.appendFileSync(nodePath.join(dir, 'chat.md'), `\n${text}\n`)
    }
    const change = edit.get(env.SETI_TASK_ID ?? '')
    if (change !== undefined) {
      const file = nodePath.join(dir, change.file)
      nodeFs.writeFileSync(file, nodeFs.readFileSync(file, 'utf8').replace(change.from, change.to))
    }
    yield fakeAssistant('Wiring the retry queue')
    yield fakeResult()
  })
  return { fake, say, edit }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.fake.query,
}))

createApp()

const ME = 'chat-me'
const PEER = 'chat-peer'
const LATER = 'chat-later'

for (const [id, title] of [
  [ME, 'Retry queue'],
  [PEER, 'Webhook signer'],
  [LATER, 'Late session'],
] as const) {
  await tasks.insert({ id, title, repo_id: null, cwd: scratch, worktree: false, pr_urls: [], seti_control: 'full' })
  await ensureMember({ id, title })
}

afterAll(async () => {
  for (const id of [ME, PEER, LATER]) {
    await endSession(id)
    const task = await tasks.get(id)
    if (task) {
      await removeTaskFiles(task)
    }
  }
  fs.rmSync(scratch, { recursive: true, force: true })
})

const file = (rel: string, taskId = ME) => path.join(workspaceDir(taskId), rel)
const read = (rel: string, taskId = ME) => fs.readFileSync(file(rel, taskId), 'utf8')

async function latestPost() {
  return (await teamMessages.list(USER_READER, 1)).at(0)
}

async function workspaceInputs(taskId = ME) {
  return (await messages.page(taskId, 200)).messages.flatMap((row) =>
    row.kind === 'input' && row.payload.source === 'workspace' ? [row.payload] : [],
  )
}

await openWorkspace(ME)

describe('workspace files', () => {
  it('renders chat.md, members.md and task.md when the workspace opens', () => {
    expect(read('chat.md')).toMatch(/^---\nmuted: false\n---\n# Group chat \(you are @retry\)/)
    expect(read('members.md')).toContain('| @retry (you) | idle | no | Retry queue |')
    expect(read('task.md')).toContain(`- Id: ${ME}`)
    expect(fs.statSync(workspaceDir(ME)).mode & 0o777).toBe(0o700)
  })
})

describe('chat.md', () => {
  it('posts an append as the agent and rewrites the file with who it reached', async () => {
    fs.appendFileSync(file('chat.md'), '\n@webhook does the signer retry? cc @ghost\n')
    await vi.waitFor(async () => {
      expect((await latestPost())?.text).toBe('@webhook does the signer retry? cc @ghost')
    })
    const posted = await latestPost()
    expect(posted).toMatchObject({ author_kind: 'task', author_task_id: ME, author_handle: 'retry' })
    await vi.waitFor(() => {
      expect(read('chat.md')).toContain(`### ${String(posted?.id)} @retry (you)`)
      expect(read('chat.md')).toContain('> seti: @webhook started a turn; @ghost unknown')
    })
    await waitIdle(PEER)
    const input = (await messages.page(PEER, 50)).messages.find((row) => row.kind === 'input')
    expect(input?.payload).toMatchObject({ source: 'team', kind: 'mention', subject: '@retry' })
    await auditEvents.settled()
    expect(await auditEvents.latest('team.message_posted')).toMatchObject({ actor: 'agent', subject_id: ME })
  })

  it('shows new messages from others as they arrive', async () => {
    await postTeamMessage({ kind: 'user' }, 'Morning, team')
    await vi.waitFor(() => {
      expect(read('chat.md')).toMatch(/### \d+ user, .*\nMorning, team\n$/)
    })
  })

  it('mutes and unmutes through the front matter, audited as the agent', async () => {
    fs.writeFileSync(file('chat.md'), read('chat.md').replace('muted: false', 'muted: true'))
    await vi.waitFor(async () => {
      expect((await teamMembers.get(ME))?.muted).toBe(true)
      await auditEvents.settled()
      expect(await auditEvents.latest('team.member_changed')).toMatchObject({ actor: 'agent', subject_id: ME })
    })
    await vi.waitFor(() => {
      expect(read('chat.md')).toMatch(/^---\nmuted: true\n/)
    })
    await updateMember(ME, { muted: false }, 'user')
    await vi.waitFor(() => {
      expect(read('chat.md')).toMatch(/^---\nmuted: false\n/)
    })
  })

  it('puts back edits above the last message and tells the agent at its next turn', async () => {
    const before = await latestPost()
    fs.writeFileSync(file('chat.md'), read('chat.md').replace('Morning, team', 'Evening, team'))
    await vi.waitFor(() => {
      expect(read('chat.md')).toContain('Morning, team')
      expect(read('chat.md')).toContain('<!-- seti: rejected: edits above the last message are put back')
    })
    expect((await latestPost())?.id).toBe(before?.id)
    await vi.waitFor(async () => {
      expect(await workspaceInputs()).toContainEqual(expect.objectContaining({ subject: 'chat.md', kind: 'rejected' }))
    })
    expect((await inputPreface(ME))?.text).toContain('<workspace-edit file="chat.md">')
  })

  it('refuses a message over the length limit', async () => {
    const before = await latestPost()
    fs.appendFileSync(file('chat.md'), `\n${'x'.repeat(4001)}\n`)
    await vi.waitFor(() => {
      expect(read('chat.md')).toContain('your message has 4001 characters')
    })
    expect((await latestPost())?.id).toBe(before?.id)
  })

  it('posts only the new part when the agent wrote to a version Seti already replaced', async () => {
    const stale = read('chat.md')
    fs.appendFileSync(file('chat.md'), '\nfirst note\n')
    await vi.waitFor(async () => {
      expect((await latestPost())?.text).toBe('first note')
    })
    fs.writeFileSync(file('chat.md'), `${stale}\nfirst note\nsecond note\n`)
    await vi.waitFor(async () => {
      expect((await latestPost())?.text).toBe('second note')
    })
    expect((await teamMessages.list(USER_READER, 3)).filter((m) => m.text === 'first note')).toHaveLength(1)
  })

  it('never loses an append that lands while Seti replaces the file', async () => {
    const rename = fs.renameSync.bind(fs)
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === file('chat.md')) {
        spy.mockRestore()
        fs.appendFileSync(file('chat.md'), '\nlanded mid-swap\n')
      }
      rename(from, to)
    })
    await postTeamMessage({ kind: 'user' }, 'This refresh races an append')
    await vi.waitFor(async () => {
      expect((await latestPost())?.text).toBe('landed mid-swap')
    })
    await vi.waitFor(() => {
      expect(read('chat.md')).toContain('landed mid-swap\n> seti:')
    })
    spy.mockRestore()
  })
})

describe('read-only files', () => {
  it('puts members.md and task.md back with a note', async () => {
    fs.writeFileSync(file('members.md'), 'nobody here')
    fs.writeFileSync(file('task.md'), 'no task')
    await vi.waitFor(() => {
      expect(read('members.md')).toContain('<!-- seti: rejected: members.md is read-only -->')
      expect(read('members.md')).toContain('@retry (you)')
      expect(read('task.md')).toContain('<!-- seti: rejected: task.md is read-only -->')
      expect(read('task.md')).toContain('- Title: Retry queue')
    })
  })
})

describe('sessions', () => {
  it('gives the agent its workspace path in the environment and the system prompt, and only the seti tools', async () => {
    const task = await tasks.get(ME)
    if (!task) {
      throw new Error('missing task')
    }
    const options = await sessionOptions(task, new AbortController())
    expect(options.env?.[WORKSPACE_ENV]).toBe(workspaceDir(ME))
    expect(Object.keys(options.mcpServers ?? {})).toEqual(['seti'])
    const prompt = JSON.stringify(options.systemPrompt)
    expect(prompt).toContain(`Your Seti workspace is ${workspaceDir(ME)}`)
    expect(prompt).not.toContain('seti-team:team-chat')
    expect(prompt).toContain('append to chat.md in it to post to the group chat')
  })

  it('renders the workspace before the agent starts, then posts its append and applies its pack edit', async () => {
    const pack = (await createPack({ name: 'Style', description: '', body: 'Be brief.' })).value
    sdk.say.set(LATER, '@retry the late session says hi')
    sdk.edit.set(LATER, { file: 'packs/style.md', from: 'Be brief.', to: 'Be brief and kind.' })
    await runTurn(LATER, 'Say hi')
    await waitIdle(LATER)
    await vi.waitFor(async () => {
      expect(await latestPost()).toMatchObject({ author_task_id: LATER, text: '@retry the late session says hi' })
      const [revision] = await revisions.list({ object_type: 'context_pack', object_id: pack.id }, 1)
      expect(revision).toMatchObject({ actor: 'agent', task_id: LATER, kind: 'updated' })
      expect(revision?.after?.body).toBe('Be brief and kind.')
    })
    expect(read('task.md', LATER)).toContain('- Title: Late session')
  })

  it('mounts the workspace read-write in the sandbox at the same path', () => {
    const dir = workspaceDir(ME)
    const layout: SandboxLayout = {
      home: path.join(scratch, 'home'),
      setiHome: path.join(scratch, 'seti'),
      worktreeRoot: path.join(scratch, 'seti', 'worktrees'),
      claudeHome: path.join(scratch, 'claude'),
      taskDir: path.join(scratch, 'seti', 'sandbox', ME),
      cwd: scratch,
      dirs: [],
      workspace: dir,
      readOnly: [],
      caDir: path.join(scratch, 'ca'),
      systemBundle: null,
      hidden: [],
      pathEnv: '',
      sessionId: null,
    }
    fs.mkdirSync(path.join(layout.taskDir, 'home'), { recursive: true })
    fs.mkdirSync(layout.home, { recursive: true })
    expect(sandboxMounts(layout)).toContainEqual({ kind: 'bind', src: dir, dest: dir })
  })
})

describe('deletion', () => {
  it('removes the workspace with the task files', async () => {
    const task = await tasks.get(PEER)
    if (!task) {
      throw new Error('missing task')
    }
    await openWorkspace(PEER)
    expect(fs.existsSync(workspaceDir(PEER))).toBe(true)
    await removeTaskFiles(task)
    expect(fs.existsSync(workspaceDir(PEER))).toBe(false)
  })
})

describe('direct messages in chat.md', () => {
  it('posts a `direct @handle` append to that agent alone and shows it to the two of them', async () => {
    await openWorkspace(ME)
    await openWorkspace(PEER)
    await openWorkspace(LATER)
    fs.appendFileSync(file('chat.md'), '\ndirect @webhook\nIs the signing key rotated yet?\n')
    await vi.waitFor(async () => {
      expect((await latestPost())?.text).toBe('Is the signing key rotated yet?')
    })
    const posted = await latestPost()
    expect(posted).toMatchObject({ author_task_id: ME, to_kind: 'task', to_task_id: PEER, to_handle: 'webhook' })
    await vi.waitFor(() => {
      expect(read('chat.md')).toContain(`### ${String(posted?.id)} @retry (you), direct to @webhook`)
      expect(read('chat.md', PEER)).toContain(`### ${String(posted?.id)} @retry, direct to you`)
    })
    expect(read('chat.md', LATER)).not.toContain('signing key')
    await waitIdle(PEER)
  })

  it('refuses a plain append right after a direct message instead of posting it publicly', async () => {
    const before = await latestPost()
    fs.appendFileSync(file('chat.md'), '\nThanks, will check\n')
    await vi.waitFor(() => {
      expect(read('chat.md')).toContain('the last message here is direct')
    })
    expect((await latestPost())?.id).toBe(before?.id)
  })

  it('answers privately with `direct`, and posts publicly only after `public`', async () => {
    fs.appendFileSync(file('chat.md', PEER), '\ndirect @retry\nYes, rotated this morning.\n')
    await vi.waitFor(async () => {
      expect(await latestPost()).toMatchObject({ text: 'Yes, rotated this morning.', to_task_id: ME })
    })
    await vi.waitFor(() => {
      expect(read('chat.md')).toContain('Yes, rotated this morning.')
    })
    expect(read('chat.md', LATER)).not.toContain('rotated this morning')
    fs.appendFileSync(file('chat.md'), '\npublic\nSigner is fine, carrying on.\n')
    await vi.waitFor(async () => {
      expect(await latestPost()).toMatchObject({ text: 'Signer is fine, carrying on.', to_kind: null })
    })
    await waitIdle(ME)
  })
})
