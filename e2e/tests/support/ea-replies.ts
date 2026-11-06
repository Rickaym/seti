import type { APIRequestContext, Page } from '@playwright/test'
import {
  DEFAULT_TIERS,
  type EaAnsweredAsk,
  type EaAsk,
  type EaLlmMessage,
  type EaUnseenReplies,
  type Envelope,
} from '@seti/shared'
import { EA_HEADERS } from './env.js'
import { expect, toasts } from './fixtures.js'

/** A new reply reaches the page at its next poll, after the moment an open EA chat gets first. */
export const REPLY_TOAST_MS = 20_000

async function asBot<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(path, { headers: EA_HEADERS, data })
  expect(response.ok(), `POST ${path}`).toBe(true)
  return ((await response.json()) as Envelope<T>).data
}

const chat = (role: 'user' | 'assistant', content: string) => ({
  kind: 'chat' as const,
  message: { role, content } as EaLlmMessage,
})

/** Stores one typed exchange as the EA bot does when no call is live, and the reply's id. */
export async function eaReplies(request: APIRequestContext, text: string, asks: number[] = []): Promise<number> {
  const body = { entries: [chat('user', 'Hello'), chat('assistant', text)], notify: true, asks }
  const { ids } = await asBot<{ ids: number[] }>(request, '/api/ea/history/messages', body)
  return ids[1] ?? 0
}

/** A question the EA asks before a tool acts, as the bot records it. */
export async function eaAsks(request: APIRequestContext, summary: string, key: string): Promise<EaAsk> {
  const body = { tool: 'delete_agent', args: { task: summary }, summary, key, epoch: 'e2e', turn: 1 }
  return asBot<EaAsk>(request, '/api/ea/asks', body)
}

/** What the EA bot takes from the answered questions. */
export const claimAnswers = async (request: APIRequestContext) =>
  asBot<EaAnsweredAsk[]>(request, '/api/ea/asks/claim', {})

export async function unseenCount(request: APIRequestContext): Promise<number> {
  const response = await request.get('/api/ea/replies')
  return ((await response.json()) as Envelope<EaUnseenReplies>).data.total
}

/** Clears the EA conversation, so no message of another spec waits unseen. */
export async function clearEaReplies(request: APIRequestContext): Promise<void> {
  expect((await request.delete('/api/ea/history')).ok()).toBe(true)
  await request.put('/api/notifications/settings', { data: DEFAULT_TIERS })
}

export const eaToast = (page: Page, text: string) => toasts(page).filter({ hasText: text })
