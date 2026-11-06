import type { MessageRow, TeamMessage } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { endsDirect, readChatEdit, readChatPost, renderChat, type ChatBase, type ChatView } from './chat.js'
import { latestLine } from './members.js'

const message = (id: number, fields: Partial<TeamMessage>): TeamMessage => ({
  id,
  author_kind: 'user',
  author_task_id: null,
  author_handle: null,
  text: 'hello',
  mentions: [],
  to_kind: null,
  to_task_id: null,
  to_handle: null,
  created_at: '2026-09-30T14:02:11.000Z',
  ...fields,
})

const view: ChatView = {
  taskId: 'me',
  handle: 'voicemail',
  muted: false,
  messages: [
    message(7, { text: 'Morning, team' }),
    message(8, {
      author_kind: 'task',
      author_task_id: 'me',
      author_handle: 'voicemail',
      text: '@webhook @quiet @gone @ghost @ea is the signer done?',
      mentions: [
        { handle: 'webhook', task_id: 'w' },
        { handle: 'quiet', task_id: 'q' },
        { handle: 'gone', task_id: 'g' },
        { handle: 'ea', task_id: null },
      ],
    }),
  ],
  deliveries: new Map([
    [
      8,
      [
        { handle: 'webhook', mode: 'now', reason: null },
        { handle: 'quiet', mode: 'skipped', reason: 'muted' },
      ],
    ],
  ]),
}

describe('chat.md', () => {
  it('renders the header, messages and what the agent own messages reached', () => {
    const text = renderChat(view)
    expect(text).toMatch(/^---\nmuted: false\n---\n# Group chat \(you are @voicemail\)\n/)
    expect(text).toContain('### 7 user, 2026-09-30 14:02Z\nMorning, team')
    expect(text).toContain('### 8 @voicemail (you), 2026-09-30 14:02Z')
    expect(text).toContain(
      '> seti: @webhook joined its running turn; @quiet not delivered, muted; @ea inbox; ' +
        '@gone not reached (archived or deleted); @ghost unknown',
    )
    expect(renderChat({ ...view, messages: [] })).toContain('No messages yet.')
  })

  it('shows a rejection note under the header', () => {
    expect(renderChat(view, 'too long')).toContain('\n<!-- seti: rejected: too long -->\n')
  })

  it('finds text appended to the newest version, with or without a newline', () => {
    const base: ChatBase = { content: renderChat(view), consumed: '' }
    expect(readChatEdit(`${base.content}@webhook ping\n`, [base])).toMatchObject({
      muted: false,
      appended: '\n@webhook ping\n',
      base,
    })
    const edited = `${base.content.trimEnd()} and more`
    expect(readChatEdit(edited, [base]).appended).toBe(' and more')
    expect(readChatEdit(base.content, [base]).appended).toBe('\n')
  })

  it('reads a mute toggle together with an append', () => {
    const base: ChatBase = { content: renderChat(view), consumed: '' }
    const text = `${base.content.replace('muted: false', 'muted: true')}\nfocusing now`
    expect(readChatEdit(text, [base])).toMatchObject({ muted: true, appended: '\n\nfocusing now' })
  })

  it('leaves out text already posted when the agent wrote to an older version', () => {
    const older: ChatBase = { content: renderChat(view), consumed: '\n\nfirst\n' }
    const newer: ChatBase = {
      content: renderChat({ ...view, messages: [...view.messages, message(9, {})] }),
      consumed: '',
    }
    const edit = readChatEdit(`${older.content}\nfirst\nsecond\n`, [newer, older])
    expect(edit).toMatchObject({ appended: 'second\n', raw: '\n\nfirst\nsecond\n', base: older })
  })

  it('takes an edit of a message Seti added since an older version as an edit, not an append', () => {
    const older: ChatBase = { content: renderChat(view), consumed: '' }
    const newer: ChatBase = {
      content: renderChat({ ...view, messages: [...view.messages, message(9, { text: 'Morning, team' })] }),
      consumed: '',
    }
    const edit = readChatEdit(newer.content.replace('Morning, team\n', 'Evening, team\n'), [newer, older])
    expect(edit).toMatchObject({ appended: null, base: null })
  })

  it('takes an append that opens with its own heading as an append', () => {
    const header = '### @voicemail, 2026-09-30'
    const older: ChatBase = { content: renderChat(view), consumed: '' }
    const mine = message(9, { author_kind: 'task', author_task_id: 'me', author_handle: 'voicemail' })
    const newer: ChatBase = {
      content: renderChat({ ...view, messages: [...view.messages, { ...mine, text: `${header}\nfirst` }] }),
      consumed: '',
    }
    expect(readChatEdit(`${newer.content}\n${header}\nsecond\n`, [newer, older])).toMatchObject({
      appended: `\n\n${header}\nsecond\n`,
      base: newer,
    })
    expect(readChatEdit(`${older.content}\n${header}\nsecond\n`, [newer, older])).toMatchObject({
      appended: `\n\n${header}\nsecond\n`,
      base: older,
    })
    const copied = '### 8 @voicemail (you), 2026-09-30 14:02Z'
    expect(readChatEdit(`${older.content}\n${copied}\nthird\n`, [newer, older])).toMatchObject({ base: older })
  })

  it('reports edits above the end', () => {
    const base: ChatBase = { content: renderChat(view), consumed: '' }
    const edit = readChatEdit(base.content.replace('Morning, team', 'Evening, team'), [base])
    expect(edit).toMatchObject({ appended: null, base: null, muted: false })
    expect(readChatEdit('no front matter at all', [base])).toMatchObject({ appended: null, muted: null })
  })
})

describe('direct messages in chat.md', () => {
  const direct: ChatView = {
    ...view,
    messages: [
      message(9, {
        author_kind: 'ea',
        text: 'Please rebase',
        to_kind: 'task',
        to_task_id: 'me',
        to_handle: 'voicemail',
      }),
      message(10, {
        author_kind: 'task',
        author_task_id: 'me',
        author_handle: 'voicemail',
        text: 'Done',
        mentions: [{ handle: 'ea', task_id: null }],
        to_kind: 'ea',
      }),
    ],
    deliveries: new Map(),
  }

  it('heads each one with who it went to, and says how to send one', () => {
    const text = renderChat(direct)
    expect(text).toContain('### 9 ea, direct to you, 2026-09-30 14:02Z\nPlease rebase')
    expect(text).toContain('### 10 @voicemail (you), direct to ea, 2026-09-30 14:02Z\nDone')
    expect(text).toContain('start with the line `direct @handle`')
    expect(endsDirect(text)).toBe(true)
    expect(endsDirect(renderChat(view))).toBe(false)
  })

  it('reads a `direct @handle` first line as a direct message to that member', () => {
    expect(readChatPost('direct @webhook\nIs the key rotated?', false)).toEqual({
      to: 'webhook',
      text: 'Is the key rotated?',
    })
    expect(readChatPost('Direct: @EA:\nline one\nline two', true)).toEqual({ to: 'ea', text: 'line one\nline two' })
    expect(readChatPost('public\nAll green', true)).toEqual({ to: null, text: 'All green' })
    expect(readChatPost('Direct links work now', false)).toEqual({ to: null, text: 'Direct links work now' })
  })

  it('refuses an append that could be private or public rather than posting it to everyone', () => {
    const refused = (appended: string, afterDirect = false) => 'refused' in readChatPost(appended, afterDirect)
    expect(refused('Thanks, will do', true)).toBe(true)
    expect(refused('direct @webhook please check the key')).toBe(true)
    expect(refused('direct @webhook @signer\nhi')).toBe(true)
    expect(refused('dm @webhook\nhi')).toBe(true)
    expect(refused('direct @webhook')).toBe(true)
    expect(refused('public')).toBe(true)
    expect(refused('Thanks, will do')).toBe(false)
  })
})

describe('members.md', () => {
  it('takes the first line of the agent latest words as what it works on', () => {
    const row = (text: string, parent: string | null = null) =>
      ({
        kind: 'sdk',
        payload: { type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'text', text }] } },
      }) as unknown as MessageRow
    expect(latestLine([row('\n  Wiring the retry queue\nmore'), row('subagent chatter', 'toolu_1')])).toBe(
      'Wiring the retry queue',
    )
    expect(latestLine([])).toBeNull()
  })
})
