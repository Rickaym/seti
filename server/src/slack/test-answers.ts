/** Slack MCP answers in the server's own formats, with neutral names, for the name readers' tests. */

export const channelRead = (name: string, id: string, body = 'Dana Reyes <dana@example.com>: hi [2026-11-24]') =>
  JSON.stringify({ messages: `Channel: #${name} (${id})\n${body}`, pagination_info: 'No more messages.' })

export const profileRead = (id: string, display: string, real: string, title = '') =>
  JSON.stringify({
    result: [
      `User ID: ${id}`,
      'Username: dana',
      `Display Name: ${display}`,
      `Real Name: ${real}`,
      'Pronouns: ',
      `Title: ${title}`,
      'Email: dana@example.com',
      'Status:  ',
      'Bot: No',
      '',
    ].join('\n'),
  })

export const threadRead = (from: string, body: string) =>
  JSON.stringify({
    messages: [
      '=== THREAD PARENT MESSAGE ===',
      from,
      'Time: 2026-11-24 10:00:00 +0000',
      'Message TS: 1764000000.000100',
      body,
    ].join('\n'),
    pagination_info: 'There are no more messages in this thread.',
  })

export interface ChannelHit {
  name: string
  id: string
  creator?: string
  purpose?: string
}

const channelHit = (hit: ChannelHit, i: number, total: number) =>
  [
    `### Result ${String(i + 1)} of ${String(total)}`,
    `Name: #${hit.name}`,
    `Creator: ${hit.creator ?? 'Dana Reyes (<@U0DANA0001>)'}`,
    'Created: 2025-01-15 09:30:00 +0000',
    ...(hit.purpose === undefined ? [] : [`Purpose: ${hit.purpose}`]),
    `Permalink: [link](https://acme.slack.com/archives/${hit.id})`,
    'Is Archived: false',
    'Channel Type: public_channel',
    '',
    '---',
    '',
  ].join('\n')

export const channelSearch = (hits: readonly ChannelHit[], stated = hits.length) =>
  JSON.stringify({
    results: [
      '# Search Results for: deploy',
      '',
      `## Channels (${String(stated)} results)`,
      ...hits.map((hit, i) => channelHit(hit, i, stated)),
    ].join('\n'),
    pagination_info: 'End of results - No more pages available.\n',
  })

export interface ListedChannel {
  heading: string
  id: string
  type: string
  user?: string
  purpose?: string
}

export const userChannels = (listed: readonly ListedChannel[], stated = listed.length) =>
  JSON.stringify({
    result: [
      `## My Channels (showing ${String(stated)} of ${String(stated)} total)`,
      '',
      ...listed.flatMap((entry) => [
        `### ${entry.heading}`,
        `- **ID:** ${entry.id}`,
        `- **Type:** ${entry.type}`,
        ...(entry.user === undefined ? [] : [`- **User ID:** ${entry.user}`]),
        ...(entry.purpose === undefined ? [] : [`- **Purpose:** ${entry.purpose}`]),
        '- **Archived:** No',
        '',
      ]),
    ].join('\n'),
  })

export const userSearch = (lines: readonly string[], stated = lines.length) =>
  JSON.stringify({
    results: ['# Search Results for: dana', '', `## Users (${String(stated)} results)`, ...lines, ''].join('\n'),
    pagination_info: 'End of results - No more pages available.\n',
  })

export const userHit = (at: { i: number; of: number }, name: string, id: string, title = '') =>
  [
    `### Result ${String(at.i)} of ${String(at.of)}`,
    `Name: ${name}`,
    `User ID: ${id}`,
    `Title: ${title}`,
    'Email: person@example.com',
    'Timezone: Europe/Berlin',
    `Permalink: [link](https://acme.slack.com/team/${id})`,
    '',
    '---',
    '',
  ].join('\n')

export const members = (people: readonly { id: string; display: string; real: string }[], stated = people.length) =>
  JSON.stringify({
    members: [
      `# Channel Members (${String(stated)})`,
      '',
      ...people.flatMap((p, i) => [
        `## Member ${String(i + 1)}`,
        `User ID: ${p.id}`,
        'Username: @person',
        `Display Name: ${p.display}`,
        `Real Name: ${p.real}`,
        'Email: person@example.com',
        '',
      ]),
    ].join('\n'),
    pagination_info: 'No more members available.\n',
  })

export const draftAnswer = (id: string, name: string, dm: boolean) =>
  JSON.stringify({
    channel_link: `https://acme.slack.com/archives/${id}`,
    widget_id: '00000000-0000-4000-8000-000000000000',
    draft_id: 'Dr0000000000',
    channel_info: { channel_id: id, name, is_dm: dm },
    result: 'Draft created.',
  })

export const sendAnswer = (id: string) =>
  JSON.stringify({
    message_link: `https://acme.slack.com/archives/${id}/p1764000000000100`,
    message_context: { message_ts: '1764000000.000100', channel_id: id },
  })
