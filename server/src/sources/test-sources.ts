/** Source tool answers in each server's own format, with neutral names and text, for ledger tests. */

export const CHANNEL = 'C0SOURCE01'
export const HOST = 'acme.slack.com'

export interface Said {
  ts: string
  lines: readonly string[]
  from?: string
}

const banner = (said: Said) =>
  `=== Message from ${said.from ?? 'Dana Reyes'} <dana@example.com> (U0DANA0001) at 2026-11-24 10:00:00 +03 === `
const quoted = (lines: readonly string[]) => lines.map((line) => (line === '' ? '>' : `> ${line}`))

/** `slack_read_channel` in the detailed form: a banner, `Message TS` and `>` lines per message. */
export const channelDetailed = (said: readonly Said[], channel = CHANNEL, name = 'release') =>
  JSON.stringify({
    messages: [
      `Channel: #${name} (${channel})`,
      ...said.flatMap((one) => ['', banner(one), `Message TS: ${one.ts}`, ...quoted(one.lines)]),
    ].join('\n'),
    pagination_info: 'There are no more messages available.',
  })

/** `slack_read_channel` with `response_format: concise`: no `ts` per message. */
export const channelConcise = (lines: readonly string[], channel = CHANNEL) =>
  JSON.stringify({
    messages: [
      `Channel: #release (${channel})`,
      '',
      'Dana Reyes <dana@example.com>: [2026-11-24 10:00:00 +03]',
      ...quoted(lines),
    ].join('\n'),
    pagination_info: 'There are no more messages available.',
  })

const block = (said: Said) => [
  `From: ${said.from ?? 'Dana Reyes'} <dana@example.com> (U0DANA0001)`,
  'Time: 2026-11-24 10:00:00 +03',
  `Message TS: ${said.ts}`,
  ...quoted(said.lines),
]

/** `slack_read_thread` in the detailed form; `stated` overrides the reply count it states. */
export const threadDetailed = (parent: Said, replies: readonly Said[], stated = replies.length) =>
  JSON.stringify({
    messages: [
      '',
      '=== THREAD PARENT MESSAGE ===',
      ...block(parent),
      '',
      `=== THREAD REPLIES (${String(stated)} total) ===`,
      ...replies.flatMap((reply, i) => ['', `--- Reply ${String(i + 1)} of ${String(stated)} ---`, ...block(reply)]),
    ].join('\n'),
    pagination_info: 'There are no more messages in this thread.',
  })

/** `slack_read_thread` with `response_format: concise`. */
export const threadConcise = (lines: readonly string[]) =>
  JSON.stringify({
    messages: ['', 'THREAD: [Dana Reyes <dana@example.com>]', ...lines.map((line) => `> > ${line}`)].join('\n'),
    pagination_info: 'There are no more messages in this thread.',
  })

export interface Hit {
  ts: string
  text: readonly string[]
  channel?: string
  link?: string
}

const permalink = (channel: string, ts: string) =>
  `https://${HOST}/archives/${channel}/p${ts.replace('.', '')}?thread_ts=${ts}&cid=${channel}`

const hit = (one: Hit, i: number, total: number) => {
  const channel = one.channel ?? CHANNEL
  return [
    `### Result ${String(i + 1)} of ${String(total)}`,
    `Channel: #release (ID: ${channel})`,
    'From: Dana Reyes <dana@example.com> (U0DANA0001)',
    'Time: 2026-11-24 10:00:00 +03',
    `Message_ts: ${one.ts}`,
    'Reply count: 2',
    `Permalink: [link](${one.link ?? permalink(channel, one.ts)})`,
    'Text:',
    ...one.text,
    'Context after:',
    '- From: Lee Park <lee@example.com> (U0LEE00001)',
    '  Message_ts: 1764000999.000100',
    '  a later reply',
    '',
    '---',
    '',
  ]
}

/** `slack_search_public` hits; `stated` overrides the count the answer states. */
export const messageSearch = (hits: readonly Hit[], stated = hits.length) =>
  JSON.stringify({
    results: [
      '# Search Results for: rollout',
      '',
      `## Messages (${String(stated)} results)`,
      ...hits.flatMap((one, i) => hit(one, i, stated)),
    ].join('\n'),
    pagination_info: 'End of results - No more pages available.\n',
  })

export const linearIssue = (id: string, description: string, url = `https://linear.app/acme/issue/${id}/a-title`) =>
  JSON.stringify({
    id,
    uuid: '00000000-0000-4000-8000-000000000001',
    title: 'Roll out the new build',
    description,
    url,
    createdAt: '2026-11-20T09:00:00.000Z',
    updatedAt: '2026-11-21T09:00:00.000Z',
    status: 'In Progress',
  })

export const linearComments = (bodies: readonly string[]) =>
  JSON.stringify({
    comments: bodies.map((body, i) => ({
      id: `0000000${String(i)}-0000-4000-8000-00000000000${String(i)}`,
      body,
      createdAt: '2026-11-22T09:00:00.000Z',
      parentId: null,
      author: { id: '00000000-0000-4000-8000-0000000000aa', name: 'Dana Reyes' },
    })),
    hasNextPage: false,
  })

export const linearIssues = (ids: readonly string[]) =>
  JSON.stringify({
    issues: ids.map((id) => ({ id, title: `Title of ${id}`, url: `https://linear.app/acme/issue/${id}/slug` })),
    hasNextPage: false,
  })

/** `gh pr view` output when it is not a terminal: `key:\tvalue` lines, `--`, then the body. */
export const prViewText = (repo: string, n: number, body: string) =>
  [
    'title:\tRoll out the new build',
    'state:\tOPEN',
    'author:\tdana',
    'labels:\t',
    `number:\t${String(n)}`,
    `url:\thttps://github.com/${repo}/pull/${String(n)}`,
    'additions:\t3',
    'deletions:\t1',
    '--',
    body,
  ].join('\n')

export const prViewJson = (repo: string, n: number, body: string) =>
  JSON.stringify({
    number: n,
    title: 'Roll out the new build',
    body,
    url: `https://github.com/${repo}/pull/${String(n)}`,
    createdAt: '2026-11-20T09:00:00Z',
    comments: [
      { body: 'a comment with a link', url: `https://github.com/${repo}/pull/${String(n)}#issuecomment-501` },
      { body: 'a comment without one' },
    ],
    reviews: [{ body: 'looks right to me', submittedAt: '2026-11-21T09:00:00Z' }],
  })

export const restComments = (repo: string, n: number, bodies: readonly string[]) =>
  JSON.stringify(
    bodies.map((body, i) => ({
      id: 700 + i,
      html_url: `https://github.com/${repo}/pull/${String(n)}#issuecomment-${String(700 + i)}`,
      body,
      created_at: '2026-11-22T09:00:00Z',
      user: { login: 'dana' },
    })),
  )

export const restPull = (repo: string, n: number, body: string) =>
  JSON.stringify({
    number: n,
    html_url: `https://github.com/${repo}/pull/${String(n)}`,
    title: 'Roll out the new build',
    body,
    created_at: '2026-11-20T09:00:00Z',
  })
