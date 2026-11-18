import type { Page } from '@playwright/test'
import { expect } from './fixtures.js'

/** The boundary logs the crash it caught before Seti reloads the page. */
export const CAUGHT_CRASH = /^Seti could not render /

export const RAW_MESSAGE = /Failed to fetch dynamically imported module/

const CONTEXT_CHUNK = /\/assets\/ContextPanel-[\w-]+\.js$/

export interface StaleBuild {
  /** Page loads so far, the first visit included. */
  loads: () => number
  /** Requests for the Context panel's file so far. */
  asked: () => number
  /** Serves the file again, as when the page runs the build the server has. */
  serve: () => void
}

/** Answers 404 for the Context panel's file, as the server does once a deploy replaced it. */
export async function loseContextChunk(page: Page, failures: number): Promise<StaleBuild> {
  let left = failures
  let asked = 0
  let loads = 0
  page.on('load', () => {
    loads += 1
  })
  await page.route(CONTEXT_CHUNK, async (route) => {
    asked += 1
    if (left > 0) {
      left -= 1
      await route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' })
    } else {
      await route.fallback()
    }
  })
  return {
    loads: () => loads,
    asked: () => asked,
    serve: () => {
      left = 0
    },
  }
}

/** Opens the agents list, then moves to Context in the same page, as a tap in the nav does. */
export async function openContextFromAgents(page: Page): Promise<void> {
  await page.goto('/#agents')
  await expect(page.getByRole('main').getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
  await page.evaluate(() => {
    window.location.hash = '#context'
  })
}

export const contextHeading = (page: Page) => page.getByRole('main').getByRole('heading', { name: 'Context', level: 1 })

/** Reports a lazy file that failed to load, the way Vite's preloader does. */
export async function reportPreloadError(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event('vite:preloadError')))
}
