import fs from 'node:fs'
import path from 'node:path'
import { paths } from './env.js'

const dir = path.join(paths.root, 'fake-gh')
const stateFile = path.join(dir, 'state.json')

/** A comment as the fake GitHub reports it on a PR. */
export interface FakeComment {
  id: string
  login: string
  body: string
  created_at: string
}

/**
 * Puts a gh on the server's PATH that answers from the state the spec writes, and polls PRs
 * every half second. Reads as the worker's env, so call it from `test.use`.
 */
export function fakeGhEnv(): NodeJS.ProcessEnv {
  fs.mkdirSync(dir, { recursive: true })
  const cli = path.join(import.meta.dirname, 'fake-gh.ts')
  fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`, { mode: 0o755 })
  return {
    PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`,
    SETI_E2E_GH_STATE: stateFile,
    SETI_PR_POLL_MS: '500',
  }
}

/** A PR node as the watch query reads it, its comments, and `closedAt` once ended. */
export function prNode(
  url: string,
  state: 'OPEN' | 'MERGED' | 'CLOSED',
  comments: readonly FakeComment[] = [],
  closedAt = '2026-10-07T11:00:00Z',
) {
  const [, slug = '', number = '0'] = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(url) ?? []
  return {
    url,
    number: Number(number),
    state,
    mergeable: 'MERGEABLE',
    closedAt: state === 'OPEN' ? null : closedAt,
    repository: { nameWithOwner: slug },
    commits: { nodes: [] },
    reviews: { nodes: [] },
    comments: {
      nodes: comments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        url: `${url}#issuecomment-${comment.id}`,
        createdAt: comment.created_at,
        author: { __typename: 'User', login: comment.login },
      })),
    },
  }
}

/** What the fake gh answers from now on: who is signed in, each PR by URL, each repo's open PRs. */
export function setFakeGh(viewer: string, prs: Record<string, unknown>, repos: Record<string, unknown[]> = {}): void {
  const next = `${stateFile}.next`
  fs.writeFileSync(next, JSON.stringify({ viewer, prs, repos }))
  fs.renameSync(next, stateFile)
}
