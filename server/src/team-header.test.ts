import { describe, expect, it } from 'vitest'
import { stripSelfHeader } from './team-header.js'
import { migrateWith } from './test-migration.js'

const BODY = '@orion agent bug on the EU pair'

const STRIPPED: [string, string][] = [
  ['eu', `### @eu, 2026-10-14 05:24Z\n${BODY}`],
  ['orion-eng-lead', `### @orion-eng-lead, 2026-10-13\n${BODY}`],
  ['whatsapp', `### 263 @whatsapp, 2026-10-04 11:02Z\n\n${BODY}`],
  ['pii', `### @pii (you), 2026-09-30 16:09Z\n${BODY}`],
  ['eng-lead', `### eng-lead, 2026-10-04 18:55Z\n${BODY}`],
  ['eu', `\n## @eu - 2026-10-09\n\n${BODY}`],
  ['eu', `### @eu \u2013 2026-10-09\n${BODY}`],
  ['eu', `@eu, 2026-10-09T10:46:00.000Z\n${BODY}`],
  ['eu', `### @eu\n### @eu, 2026-10-09\n${BODY}`],
  ['user', `### user, 2026-10-09 10:46 UTC\r\n${BODY}`],
  ['ea', `### @ea\n${BODY}`],
]

const KEPT: [string, string][] = [
  ['eu', `### @orion-eng-lead, 2026-10-13\n${BODY}`],
  ['eu', `### @eu-staging, 2026-10-13\n${BODY}`],
  ['eu', `### @eu findings, 2026-10-13\n${BODY}`],
  ['pii', `### 23 @pii (methods), 2026-09-30 16:09Z\n${BODY}`],
  ['eu', `@eu\n${BODY}`],
  ['eu', `${BODY}\n### @eu, 2026-10-13`],
  ['eu', '### @eu, 2026-10-13'],
  ['eu', '### @eu, 2026-10-13\n\n'],
]

describe('stripSelfHeader', () => {
  it.each(STRIPPED)('drops a heading that names only @%s', (name, text) => {
    expect(stripSelfHeader(text, name)).toBe(BODY)
  })

  it.each(KEPT)('keeps a post by @%s whose opening line says more, or that is only a heading', (name, text) => {
    expect(stripSelfHeader(text, name)).toBe(text)
  })

  it('leaves the rest of the post as written', () => {
    const body = '  indented\n\n### @eu, 2026-10-13\nlater'
    expect(stripSelfHeader(`### @eu, 2026-10-13\n\n${body}`, 'eu')).toBe(body)
  })
})

describe('team_message_self_headers migration', () => {
  const rows: [string, string | null, string][] = [
    ...[...STRIPPED, ...KEPT].map(([name, text]): [string, string | null, string] =>
      name === 'user' || name === 'ea' ? [name, null, text] : ['task', name, text],
    ),
    ['user', null, `### @eu, 2026-10-13\n${BODY}`],
    ['task', null, `### @task, 2026-10-13\n${BODY}`],
  ]
  const literal = (value: string | null) => (value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`)
  const seed = `INSERT INTO team_message (id, author_kind, author_handle, text, created_at) VALUES ${rows
    .map(
      ([kind, handle, text], index) => `(${String(index + 1)}, '${kind}', ${literal(handle)}, ${literal(text)}, 'x')`,
    )
    .join(', ')};`

  it('strips the same headings as new posts, only where they name the row author', async () => {
    const texts = await migrateWith('team_message_self_headers', seed, async (tx) =>
      (await tx<{ text: string }[]>`SELECT text FROM team_message ORDER BY id`).map((row) => row.text),
    )
    const expected = rows.map(([kind, handle, text]) =>
      handle === null && kind === 'task' ? text : stripSelfHeader(text, handle ?? kind),
    )
    expect(texts).toEqual(expected)
    expect(texts.filter((text) => text === BODY)).toHaveLength(STRIPPED.length)
  })
})
