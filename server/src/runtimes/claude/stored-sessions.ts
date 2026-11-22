import { forkSession, getSessionInfo, getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk'
import type { SessionDeps } from '../../session-service.js'

/** The sessions Claude Code saved on this machine, as the session browser lists and forks them. */
export const claudeStoredSessions: SessionDeps['sdk'] = {
  listSessions,
  getSessionInfo: async (sessionId) => getSessionInfo(sessionId),
  getSessionMessages: async (sessionId) => getSessionMessages(sessionId),
  forkSession,
}
