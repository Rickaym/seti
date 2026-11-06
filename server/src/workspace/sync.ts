import fs from 'node:fs'
import path from 'node:path'
import { TEAM_TEXT_MAX, type WorkspaceInput } from '@seti/shared'
import { inBackground } from '../background.js'
import { HttpError } from '../http.js'
import { appendMessage } from '../runner.js'
import { inLane, outsideLane } from '../task-lane.js'
import { postTeamMessage, teamMemberOf, updateMember } from '../team.js'
import { applyContext, applyPack, type Edit, type Outcome } from './apply.js'
import { endsDirect, readChatEdit, readChatPost, renderChat, type ChatBase } from './chat.js'
import { CHAT, CONTEXT, MEMBERS, PACKS, TASK, workspaceDir, type WorkspaceArea } from './dir.js'
import { explain, readText, removeIf, swap } from './files.js'
import { insertNote } from './objects.js'
import {
  canonical,
  chatView,
  contextEntries,
  contextFiles,
  membersFile,
  packFiles,
  taskFile,
  type Rendered,
  type RenderedObject,
} from './render.js'

const DEBOUNCE_MS = 300
const CHAT_VERSIONS = 5

const OBJECT_DIRS = { packs: PACKS, context: CONTEXT } as const
type ObjectArea = keyof typeof OBJECT_DIRS
const OBJECT_AREAS = Object.keys(OBJECT_DIRS) as ObjectArea[]

const REMOVED: Record<ObjectArea, string> = {
  packs: 'deleting this file does not delete the pack; ask the user or @ea if it should go',
  context: 'deleting this copy does not delete the CLAUDE.md file; empty it instead',
}

function subfolders(root: string): string[] {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
}

const areaOf = (rel: string): ObjectArea | null =>
  OBJECT_AREAS.find((area) => rel.startsWith(`${OBJECT_DIRS[area]}/`)) ?? null

/** One task's workspace: the files Seti wrote, what they stand for, and the watcher on them. */
export class Workspace {
  readonly taskId: string
  readonly dir: string
  private readonly written = new Map<string, string>()
  private readonly stamps = new Map<string, string | null>()
  /** Files that hold a rejected edit with its note, which refreshes leave for the agent to fix. */
  private readonly kept = new Set<string>()
  /** The pack or CLAUDE.md file each file stands for. */
  private readonly objects: Record<ObjectArea, Map<string, string>> = {
    packs: new Map(),
    context: new Map(),
  }
  private chatBases: ChatBase[] = []
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly pendingAreas = new Set<WorkspaceArea>()
  private areaTimer: NodeJS.Timeout | null = null
  private readonly watchers = new Map<string, fs.FSWatcher>()
  private chain: Promise<void> = Promise.resolve()
  closeTimer: NodeJS.Timeout | null = null
  private closed = false

  constructor(taskId: string) {
    this.taskId = taskId
    this.dir = workspaceDir(taskId)
  }

  /** Runs work on this workspace one piece at a time. */
  async run(work: () => Promise<void>): Promise<void> {
    const next = this.chain.then(work).catch((e: unknown) => {
      process.stderr.write(`workspace: task ${this.taskId}: ${explain(e)}\n`)
    })
    this.chain = next
    return next
  }

  /** Watches the workspace and each folder in it; a folder watch that fails is retried later. */
  watch(): void {
    for (const dir of ['', ...subfolders(this.dir)]) {
      if (this.watchers.has(dir)) {
        continue
      }
      const watcher = fs.watch(path.join(this.dir, dir), (_event, name) => {
        if (name !== null) {
          this.schedule(path.join(dir, name))
        }
      })
      watcher.on('error', () => {
        watcher.close()
        this.watchers.delete(dir)
      })
      this.watchers.set(dir, watcher)
    }
  }

  private unwatch(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close()
    }
    this.watchers.clear()
  }

  private schedule(rel: string): void {
    if (!rel.endsWith('.md') || path.basename(rel).startsWith('.')) {
      return
    }
    clearTimeout(this.timers.get(rel))
    this.timers.set(
      rel,
      setTimeout(() => {
        this.timers.delete(rel)
        void this.run(async () => this.sync(rel))
      }, DEBOUNCE_MS),
    )
  }

  requestRefresh(areas: readonly WorkspaceArea[]): void {
    for (const area of areas) {
      this.pendingAreas.add(area)
    }
    this.areaTimer ??= setTimeout(() => {
      this.areaTimer = null
      const due = [...this.pendingAreas]
      this.pendingAreas.clear()
      void this.run(async () => this.refresh(due))
    }, DEBOUNCE_MS)
  }

  /** Handles the edits that still wait for their debounce. */
  async flush(): Promise<void> {
    const due = [...this.timers.keys()]
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
    for (const rel of due) {
      await this.run(async () => this.sync(rel))
    }
    await this.chain
  }

  /** Stops watching, after handling the edits that still wait for their debounce. */
  async close(): Promise<void> {
    clearTimeout(this.closeTimer ?? undefined)
    clearTimeout(this.areaTimer ?? undefined)
    this.unwatch()
    this.closed = true
    await this.flush()
  }

  /** Writes every file from the platform's data, dropping stale files and edits Seti never saw. */
  async renderAll(): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    this.unwatch()
    for (const sub of Object.values(OBJECT_DIRS)) {
      fs.rmSync(path.join(this.dir, sub), { recursive: true, force: true })
    }
    this.written.clear()
    this.stamps.clear()
    this.kept.clear()
    for (const area of OBJECT_AREAS) {
      this.objects[area].clear()
    }
    this.chatBases = []
    await this.refresh(['chat', 'members', 'task', ...OBJECT_AREAS], true)
  }

  private async objectFiles(area: ObjectArea): Promise<Map<string, RenderedObject>> {
    if (area === 'packs') {
      return packFiles(this.taskId)
    }
    return contextFiles()
  }

  /** Rewrites the areas' files if the workspace exists; unless forced, agent edits are kept. */
  async refresh(areas: readonly WorkspaceArea[], force = false): Promise<void> {
    if (!fs.existsSync(this.dir)) {
      return
    }
    const want = new Set(areas)
    if (want.has('chat')) {
      await this.writeChat(null, force ? undefined : (this.written.get(CHAT) ?? null))
    }
    const files = new Map<string, Rendered>()
    if (want.has('members')) {
      files.set(MEMBERS, await membersFile(this.taskId))
    }
    const task = want.has('task') ? await taskFile(this.taskId) : null
    if (task !== null) {
      files.set(TASK, task)
    }
    for (const area of OBJECT_AREAS.filter((wanted) => want.has(wanted))) {
      const rendered = await this.objectFiles(area)
      this.forgetMissing(this.objects[area], rendered)
      for (const [rel, file] of rendered) {
        this.objects[area].set(rel, file.id)
        files.set(rel, file)
      }
    }
    for (const [rel, file] of files) {
      this.refreshFile(rel, file, force)
    }
    if (!this.closed) {
      this.watch()
    }
  }

  private forgetMissing(mapping: Map<string, string>, rendered: ReadonlyMap<string, unknown>): void {
    for (const rel of [...mapping.keys()].filter((known) => !rendered.has(known))) {
      mapping.delete(rel)
      removeIf(this.dir, rel, this.written.get(rel) ?? null)
      this.written.delete(rel)
      this.stamps.delete(rel)
    }
  }

  private refreshFile(rel: string, file: Rendered, force: boolean): void {
    if (!force && this.kept.has(rel)) {
      return
    }
    if (!force && this.written.get(rel) === file.text) {
      this.stamps.set(rel, file.stamp)
      return
    }
    if (this.write(rel, file.text, force ? undefined : (this.written.get(rel) ?? null))) {
      this.stamps.set(rel, file.stamp)
    }
  }

  /** Swaps the file in while it holds `expected`; true when written. */
  private write(rel: string, text: string, expected: string | null | undefined): boolean {
    const result = swap(this.dir, rel, text, expected)
    if (!result.ok) {
      return false
    }
    this.written.set(rel, text)
    this.kept.delete(rel)
    if (result.late !== null) {
      this.reject(rel, 'Seti rewrote this file while you edited it; read it again and redo your edit')
    }
    return true
  }

  /** Rewrites chat.md while it holds `expected`; text appended during the swap is posted too. */
  private async writeChat(note: string | null, expected: string | null | undefined): Promise<void> {
    const text = renderChat(await chatView(this.taskId), note)
    const same = text === expected && readText(this.dir, CHAT) === text
    const result = same ? { ok: true, before: text, late: null } : swap(this.dir, CHAT, text, expected)
    if (!result.ok) {
      return
    }
    this.written.set(CHAT, text)
    if (this.chatBases[0]?.content !== text) {
      this.chatBases = [{ content: text, consumed: '' }, ...this.chatBases].slice(0, CHAT_VERSIONS)
    }
    const before = result.before ?? ''
    if (result.late?.startsWith(before) === true) {
      const extra = result.late.slice(before.length).trim()
      if (extra !== '') {
        await this.writeChat(await this.post(extra, endsDirect(before)), text)
      }
    }
  }

  /** Posts as this task, directly when the text says so; returns why it did not, or null. */
  private async post(appended: string, afterDirect: boolean): Promise<string | null> {
    const post = readChatPost(appended, afterDirect)
    if ('refused' in post) {
      return post.refused
    }
    if (post.text.length > TEAM_TEXT_MAX) {
      const size = `${String(post.text.length)} characters, over the limit of ${String(TEAM_TEXT_MAX)}`
      return `your message has ${size}; it was not posted`
    }
    try {
      await postTeamMessage({ kind: 'task', taskId: this.taskId }, post.text, { to: post.to ?? undefined })
    } catch (e) {
      if (e instanceof HttpError) {
        return `${e.message}; it was not posted`
      }
      throw e
    }
    return null
  }

  private async syncChat(text: string | null): Promise<void> {
    if (text === null) {
      await this.writeChat(null, null)
      return
    }
    const edit = readChatEdit(text, this.chatBases)
    const member = await teamMemberOf(this.taskId)
    if (edit.muted !== null && edit.muted !== member.muted) {
      await updateMember(this.taskId, { muted: edit.muted }, 'agent')
    }
    let note: string | null = null
    if (edit.appended === null || edit.base === null) {
      note = 'edits above the last message are put back; append new text at the end of the file'
    } else {
      edit.base.consumed = edit.raw
      const message = edit.appended.trim()
      note = message === '' ? null : await this.post(message, endsDirect(edit.base.content))
    }
    await this.writeChat(note, text)
    if (note !== null) {
      this.reject(CHAT, note)
    }
  }

  /** Handles a change the watcher saw; Seti's own writes compare equal and do nothing. */
  async sync(rel: string): Promise<void> {
    if (!fs.existsSync(this.dir)) {
      return
    }
    const text = readText(this.dir, rel)
    if (text === (this.written.get(rel) ?? null)) {
      return
    }
    if (rel === CHAT) {
      await this.syncChat(text)
      return
    }
    if (rel === MEMBERS || rel === TASK) {
      await this.restore(rel, `${rel} is read-only`)
      return
    }
    const area = areaOf(rel)
    if (area !== null) {
      await this.syncObject(area, rel, text)
    }
  }

  private async syncObject(area: ObjectArea, rel: string, text: string | null): Promise<void> {
    const id = this.objects[area].get(rel)
    if (text === null) {
      if (id !== undefined) {
        await this.restore(rel, REMOVED[area])
      }
      return
    }
    const edit: Edit = { taskId: this.taskId, rel, text, stamp: this.stamps.get(rel) }
    const outcome = await this.apply(area, edit, id)
    if (outcome.kind === 'keep') {
      this.keep(rel, text, outcome.reason)
    } else if (outcome.kind === 'restore') {
      await this.restore(rel, outcome.reason)
    } else {
      await this.applied(area, rel, text)
    }
  }

  private async apply(area: ObjectArea, edit: Edit, id: string | undefined): Promise<Outcome> {
    if (area === 'packs') {
      return applyPack(edit, id)
    }
    const key = id ?? (await contextEntries()).find((entry) => entry.rel === edit.rel)?.key
    if (key === undefined) {
      const only = 'context/CLAUDE.md and context/<owner>/<repo>/CLAUDE.md or CLAUDE.local.md of known repos'
      return { kind: 'keep', reason: `only ${only} sync` }
    }
    return applyContext(edit, key, id !== undefined)
  }

  /** Rewrites the area after Seti applied the agent's version of one of its files. */
  private async applied(area: ObjectArea, rel: string, text: string): Promise<void> {
    await this.refresh([area])
    const file = await canonical(this.taskId, rel)
    if (file === null) {
      removeIf(this.dir, rel, text)
      this.written.delete(rel)
      this.kept.delete(rel)
      return
    }
    this.stamps.set(rel, file.stamp)
    this.write(rel, file.text, text)
  }

  /** Puts Seti's version back with a note on why, and tells the agent at its next turn. */
  private async restore(rel: string, reason: string): Promise<void> {
    const file = await canonical(this.taskId, rel)
    if (file !== null && this.write(rel, insertNote(file.text, reason), undefined)) {
      this.stamps.set(rel, file.stamp)
    }
    this.reject(rel, reason)
  }

  /** Leaves the agent's version in place with a note on why Seti did not apply it. */
  private keep(rel: string, text: string, reason: string): void {
    if (this.write(rel, insertNote(text, reason), text)) {
      this.kept.add(rel)
    }
    this.reject(rel, reason)
  }

  private reject(rel: string, reason: string): void {
    const payload: WorkspaceInput = {
      source: 'workspace',
      kind: 'rejected',
      subject: rel,
      title: `Seti did not apply your edit to ${rel}`,
      body: reason,
      url: null,
    }
    inBackground(`workspace: task ${this.taskId}`, async () =>
      outsideLane(async () => inLane(this.taskId, async () => appendMessage(this.taskId, { kind: 'input', payload }))),
    )
  }
}
