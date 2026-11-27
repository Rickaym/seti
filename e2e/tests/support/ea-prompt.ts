import type { Page } from '@playwright/test'
import type { EaPromptPart } from '@seti/shared'

const BASE = [
  '# Role',
  'You are the Executive Assistant in Seti, a control room for coding agents.',
  '# Channels',
  'On a call, speak in short sentences. In the chat, write in short paragraphs.',
  ...Array.from({ length: 300 }, (_, i) => `- Rule ${String(i + 1)}: say what changed, and ask before you act.`),
].join('\n')

const part = (fields: Omit<EaPromptPart, 'chars' | 'per_turn' | 'built_at'>, at?: string): EaPromptPart => ({
  ...fields,
  chars: fields.text.length,
  per_turn: fields.key !== 'base',
  built_at: at ?? null,
})

/** The parts a running EA answers, with a base prompt about as long as the real one. */
const promptParts = (sentAt: string): EaPromptPart[] => [
  part({ key: 'base', label: 'Base prompt', about: 'The system prompt of every call and chat.', text: BASE }),
  part({
    key: 'call',
    label: 'Call note',
    about: 'Added as a call opens.',
    text: "A new call started. The user's local time is Friday 27 November 2026, 09:30 (Europe/Berlin).",
  }),
  part({
    key: 'chat',
    label: 'Chat note',
    about: 'Opens a typed turn, with your local time.',
    text: 'The user is typing in the Seti chat now; use the chat reply style.',
  }),
  part({
    key: 'inbox',
    label: 'Inbox note',
    about: 'Opens a report the EA writes to the chat on its own.',
    text: 'The inbox notes above arrived while no call was on.',
  }),
  part(
    {
      key: 'live',
      label: 'Live context',
      about: 'Changes every turn. This is the one the last turn was given.',
      text: 'Live Seti context, 4 seconds old.\nTasks: 3 in all; 1 running.\n- Atlas: fix the login redirect',
    },
    sentAt,
  ),
]

/** Answers the EA prompt as a running EA would. */
export async function fakeEaPrompt(page: Page): Promise<void> {
  const sentAt = new Date(Date.now() - 120_000).toISOString()
  await page.route('**/api/ea/prompt', async (route) =>
    route.fulfill({ json: { data: { commit: '0123456789abcdef', parts: promptParts(sentAt) } } }),
  )
}
