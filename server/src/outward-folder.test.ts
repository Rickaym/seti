import os from 'node:os'
import path from 'node:path'
import type { Task } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { agentGitView } from './outward-folder.js'
import { sandboxDirOf } from './owned-dirs.js'

const state = vi.hoisted(() => ({ boxed: true }))

vi.mock('./aws-access.js', () => ({ sandboxed: async () => Promise.resolve(state.boxed) }))

const home = os.homedir()
const cwd = path.join(home, 'work', 'agent')
const task = { id: 'view', cwd, dirs: [], repos: [], home_access: false } as unknown as Task
const box = sandboxDirOf('view')

describe("how the host sees an agent's git", () => {
  it("reads a sandboxed agent's folders as named and its private home and /tmp from its sandbox", async () => {
    state.boxed = true
    const view = await agentGitView(task)
    expect(view.folder(path.join(cwd, 'clone'))).toBe(path.join(cwd, 'clone'))
    expect(view.folder(path.join(path.sep, 'tmp', 'clone'))).toBe(path.join(box, 'tmp', 'clone'))
    expect(view.folder(path.join(home, 'clone'))).toBe(path.join(box, 'home', 'clone'))
    expect(view.folder('/opt/clone')).toBe('/opt/clone')
    expect(view.globals).toEqual([
      path.join(box, 'home', '.config', 'git', 'config'),
      path.join(box, 'home', '.gitconfig'),
    ])
  })

  it("reads an agent outside the sandbox where it runs, with the user's global config", async () => {
    state.boxed = false
    const view = await agentGitView(task)
    const tmp = path.join(path.sep, 'tmp', 'clone')
    expect(view.folder(tmp)).toBe(tmp)
    expect(view.globals).toContain(path.join(home, '.gitconfig'))
  })
})
