import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { openSeedDb } from './db.js'
import { paths } from './env.js'

/** What Chromium logs for each request the lost link drops. */
export const DROPPED_REQUEST = /net::ERR_(TIMED_OUT|FAILED)/

const API = '**/api/**'

/** An idle agent to keep on screen while the link is gone; returns its title. */
export async function seedListedAgent(): Promise<string> {
  const db = openSeedDb()
  const title = `Stays listed ${randomUUID().slice(0, 8)}`
  await db.idleTask(randomUUID(), title, paths.checkout, new Date().toISOString())
  await db.close()
  return title
}

/** Drops every API request as a dead link does, until the returned function restores it. */
export async function loseLink(page: Page): Promise<() => Promise<void>> {
  await page.route(API, async (route) => route.abort('timedout'))
  return async () => page.unroute(API)
}
