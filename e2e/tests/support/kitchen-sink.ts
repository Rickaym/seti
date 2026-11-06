import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { type APIRequestContext, expect } from '@playwright/test'
import type { Connection, Envelope, TeamMember } from '@seti/shared'
import { openSeedDb } from './db.js'
import { paths } from './env.js'

export const KITCHEN_SINK = 'kitchen-sink'

/** The handle the kitchen sink's agent filter names. */
const HANDLE = 'sink-builder'

/** A fake key the sink upstream receives; the mod itself never holds it. */
const SINK_KEY = `sink-${randomUUID()}`

export interface SinkAgent {
  id: string
  title: string
  dir: string
}

let builder: SinkAgent | null = null

/** The idle agent the kitchen sink may read, with a plan and a .sink file in its folder. */
export async function builderAgent(request: APIRequestContext): Promise<SinkAgent> {
  if (builder !== null) {
    return builder
  }
  const id = randomUUID()
  const dir = path.join(paths.root, `sink-${id.slice(0, 8)}`)
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'notes', 'plan.md'), '# Ship the sink\n\nThen test it.\n')
  fs.writeFileSync(path.join(dir, 'docs', 'stock.sink'), 'one\ntwo\nthree\n')
  const db = openSeedDb()
  await db.idleTask(id, 'Sink builder', dir, new Date(Date.now() - 60_000).toISOString())
  await db.close()
  const member = await request.patch(`/api/team/members/${id}`, { data: { handle: HANDLE } })
  expect(member.status(), await member.text()).toBe(200)
  expect(((await member.json()) as Envelope<TeamMember>).data.handle).toBe(HANDLE)
  builder = { id, title: 'Sink builder', dir }
  return builder
}

/** The SINK_TOKEN connection the user binds to the kitchen sink, made once per worker. */
export async function sinkConnection(request: APIRequestContext): Promise<string> {
  const listed = await request.get('/api/connections')
  const found = ((await listed.json()) as Envelope<Connection[]>).data.find((entry) => entry.env === 'SINK_TOKEN')
  if (found !== undefined) {
    return found.id
  }
  const created = await request.post('/api/connections', {
    data: {
      name: 'sink_token',
      kind: 'key',
      env: 'SINK_TOKEN',
      hosts: ['api.sink.test'],
      header: { name: 'Authorization', template: 'Bearer {{value}}' },
      values: { value: SINK_KEY },
    },
  })
  expect(created.status(), await created.text()).toBe(200)
  return ((await created.json()) as Envelope<Connection>).data.id
}
