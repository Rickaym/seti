import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { APIRequestContext } from '@playwright/test'
import type { CodexSettingsInput } from '@seti/shared'
import { PINNED_CODEX } from './codex-registry.js'
import { openSeedDb } from './db.js'
import { paths } from './env.js'
import { expect } from './fixtures.js'

export { PINNED_CODEX }

/**
 * A scripted stand-in for the codex program that only answers `--version`: these specs check
 * Settings and the start page, never a Codex session, which the server's own tests run for real.
 */
export function codexStandIn(version: string): string {
  const dir = fs.mkdtempSync(path.join(paths.root, 'codex-stand-in-'))
  const program = path.join(dir, 'codex')
  fs.writeFileSync(program, `#!/bin/sh\necho "codex-cli ${version}"\n`, { mode: 0o755 })
  return program
}

async function setCodex(request: APIRequestContext, body: CodexSettingsInput): Promise<void> {
  const response = await request.put('/api/runtimes/codex', { data: body })
  expect(response.ok(), 'PUT /api/runtimes/codex').toBe(true)
}

const KEY_CONNECTION = 'e2e_openai'

/**
 * A connection in the default credential that adds a header on OpenAI's API, as the user adds
 * one; its value is a dummy no request ever carries, since these specs start no Codex session.
 */
export async function codexKey(request: APIRequestContext): Promise<void> {
  const response = await request.post('/api/connections', {
    data: {
      name: KEY_CONNECTION,
      kind: 'key',
      env: 'E2E_OPENAI',
      hosts: ['api.openai.com'],
      header: { name: 'Authorization', template: 'Bearer {{value}}' },
      values: { value: 'e2e-not-a-key' },
      profile_ids: ['default'],
    },
  })
  expect(response.ok(), 'POST /api/connections').toBe(true)
}

async function dropKey(request: APIRequestContext): Promise<void> {
  const listed = (await (await request.get('/api/connections')).json()) as { data: { id: string; name: string }[] }
  for (const each of listed.data.filter((connection) => connection.name === KEY_CONNECTION)) {
    await request.delete(`/api/connections/${each.id}`)
  }
}

/** Codex on with a program that reports the pinned version and a key, so new agents may pick it. */
export async function codexReady(request: APIRequestContext): Promise<void> {
  await setCodex(request, { enabled: true, program: codexStandIn(PINNED_CODEX) })
  await codexKey(request)
}

/** Back to how a fresh Seti starts: off, with no program named and no OpenAI key. */
export async function codexOff(request: APIRequestContext): Promise<void> {
  await dropKey(request)
  await setCodex(request, {
    enabled: false,
    program: null,
    evaluator_decides: false,
    default_model: null,
    default_effort: null,
  })
}

export const CODEX_COMMAND = 'npm test'

/**
 * Seeds an idle agent recorded as a Codex agent, with one command it asks to run: rows that
 * stand in for a Codex session, which these specs never start.
 */
export async function seedCodexAgent(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const at = new Date().toISOString()
  try {
    await db.idleTask(id, title, paths.checkout, at)
    await db.run(
      `UPDATE task SET runtime = 'codex', requested_model = 'gpt-5.5', requested_effort = 'high', blocked = ?
        WHERE id = ?`,
      `Asks to use Bash: ${CODEX_COMMAND}`,
      id,
    )
    await db.run(
      `INSERT INTO permission_request (id, task_id, tool_name, kind, summary, input, reason, suggestions,
        editable, state, created_at) VALUES (?, ?, 'Bash', 'tool', ?, ?, NULL, '[]', false, 'pending', ?)`,
      randomUUID(),
      id,
      CODEX_COMMAND,
      JSON.stringify({ command: CODEX_COMMAND }),
      at,
    )
  } finally {
    await db.close()
  }
  return id
}
