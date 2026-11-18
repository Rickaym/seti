import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { tasks } from './db.js'
import {
  borrowedServers,
  borrowedStamp,
  isBorrowed,
  localServers,
  ownProjects,
  taskBorrowedServers,
  tilde,
} from './mcp-borrowed.js'
import { mcpDefaults, taskMcpChoices } from './store/mcp.js'

const staging = { type: 'http', url: 'https://staging.example.com/api/mcp' }
const keyed = { type: 'http', url: 'https://staging.example.com/api/mcp', headers: { Authorization: 'Bearer k' } }

const host = {
  mcpServers: { tracker: { type: 'http', url: 'https://tracker.example.com/mcp' } },
  projects: {
    '/home/me': { mcpServers: { 'staging-mine': keyed, tracker: { type: 'http', url: 'https://other.example.com' } } },
    '/home/me/dash-2': { mcpServers: { staging: { type: 'http', url: 'https://second.example.com/mcp' } } },
    '/home/me/dash': { mcpServers: { staging } },
    '/work/api': { history: ['a prompt'], mcpServers: { 'api-local': { command: 'api-mcp' } } },
  },
}

describe('borrowedServers', () => {
  it("lends a session the local servers of other directories, but not its own or the user's", () => {
    expect(borrowedServers(host, ['/work/api'], () => true)).toEqual({ 'staging-mine': keyed, staging })
  })

  it('takes only the servers the agent has on, and nothing from a config without projects', () => {
    expect(borrowedServers(host, ['/work/api'], (name) => name === 'staging')).toEqual({ staging })
    expect(borrowedServers({}, ['/work/api'], () => true)).toEqual({})
  })

  it('leaves out what the directory or its repo root has already', () => {
    expect(Object.keys(borrowedServers(host, ['/work/api-wt', '/home/me/dash'], () => true))).toEqual([
      'staging-mine',
      'api-local',
    ])
  })

  it('stamps names and a digest, never the keys themselves', () => {
    const stamp = borrowedStamp({ 'staging-mine': keyed })
    expect(stamp.names).toEqual(['staging-mine'])
    expect(JSON.stringify(stamp)).not.toContain('Bearer')
    expect(borrowedStamp({ 'staging-mine': staging }).digest).not.toBe(stamp.digest)
  })
})

describe('ownProjects', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seti-own-projects-')))
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }

  it('counts the main checkout of a real worktree, and never a repository a forged .git file names', () => {
    const main = path.join(root, 'main')
    const worktree = path.join(root, 'main-feature')
    const admin = path.join(main, '.git', 'worktrees', 'main-feature')
    write(path.join(worktree, '.git'), `gitdir: ${admin}\n`)
    write(path.join(admin, 'commondir'), '../..\n')
    write(path.join(admin, 'gitdir'), `${path.join(worktree, '.git')}\n`)
    expect(ownProjects(worktree)).toEqual([worktree, main])

    const forged = path.join(root, 'agent-folder')
    const state = path.join(root, 'agent-folder-state')
    write(path.join(forged, '.git'), `gitdir: ${state}\n`)
    write(path.join(state, 'commondir'), `${path.join(main, '.git')}\n`)
    write(path.join(state, 'gitdir'), `${path.join(forged, '.git')}\n`)
    expect(ownProjects(forged)).toEqual([forged])
    const local = { projects: { [main]: { mcpServers: { 'main-local': { command: 'main-mcp' } } } } }
    expect(Object.keys(borrowedServers(local, ownProjects(forged), () => true))).toEqual(['main-local'])
    expect(borrowedServers(local, ownProjects(forged), () => false)).toEqual({})
    expect(borrowedServers(local, ownProjects(worktree), () => true)).toEqual({})
    fs.rmSync(root, { recursive: true, force: true })
  })
})

describe('localServers and isBorrowed', () => {
  it('lists servers only a local config has, by directory, and which an agent borrows', () => {
    const local = localServers(host)
    expect([...local]).toEqual([
      ['staging-mine', ['/home/me']],
      ['staging', ['/home/me/dash', '/home/me/dash-2']],
      ['api-local', ['/work/api']],
    ])
    const fromApi = isBorrowed(local, ['/work/api'])
    expect(['staging', 'api-local', 'tracker'].map(fromApi)).toEqual([true, false, false])
    expect(isBorrowed(local, null)('api-local')).toBe(true)
    expect(tilde('/home/me/dash', '/home/me')).toBe('~/dash')
    expect(tilde('/home/meta', '/home/me')).toBe('/home/meta')
  })
})

describe('taskBorrowedServers', () => {
  it("keeps borrowed servers off unless the Default or the agent's own choice turns them on", async () => {
    await tasks.insert({ id: 'borrow-1', title: 'b', repo_id: null, cwd: '/work/api', worktree: false, pr_urls: [] })
    const task = { id: 'borrow-1', cwd: '/work/api' }
    expect(await taskBorrowedServers(task, host)).toEqual({})
    await mcpDefaults.set('staging', true, false)
    expect(await mcpDefaults.all()).toEqual({ staging: true })
    expect(Object.keys(await taskBorrowedServers(task, host))).toEqual(['staging'])
    await taskMcpChoices.set(task.id, { 'staging-mine': true, staging: false })
    expect(Object.keys(await taskBorrowedServers(task, host))).toEqual(['staging-mine'])
    await mcpDefaults.set('staging', false, false)
    expect(await mcpDefaults.all()).toEqual({})
  })
})
