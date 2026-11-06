import fs from 'node:fs'
import { forkSession, getSessionInfo, getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk'
import { inBackground } from './background.js'
import { repos, tasks } from './db.js'
import { listWorktrees } from './git.js'
import { planTitle } from './planner.js'
import { prDiscovery } from './pr-discovery.js'
import { cachedOpenPrs } from './prs.js'
import { createSessionService } from './session-service.js'
import { sessionLinks } from './store/sessions.js'
import { createImportedTask } from './tasks.js'

export const sessionService = createSessionService({
  sdk: {
    listSessions,
    getSessionInfo: async (sessionId) => getSessionInfo(sessionId),
    getSessionMessages: async (sessionId) => getSessionMessages(sessionId),
    forkSession,
  },
  repos: repos.list,
  worktrees: listWorktrees,
  openPrs: cachedOpenPrs,
  knownSessions: sessionLinks.known,
  exists: fs.existsSync,
  createTask: async (input) => {
    const task = await createImportedTask(input)
    inBackground('pr discovery', async () => prDiscovery.run(task.id))
    return task
  },
  title: planTitle,
})

/** Tells the agent of an imported task that it continues a session the user started elsewhere. */
export async function importedContext(taskId: string): Promise<string | null> {
  const task = await tasks.get(taskId)
  if (typeof task?.source_session_id !== 'string') {
    return null
  }
  return [
    'This task continues a Claude Code session the user started outside Seti, in a terminal or IDE.',
    `Earlier turns may have run in another working directory or on another machine; you now work in ${task.cwd}.`,
  ].join(' ')
}
