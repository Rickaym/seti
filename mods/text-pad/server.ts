import { defineMod, type ModRequest, type ModResponse, type ServerModApi } from '@seti/mod-api'
import { PAD_MAX, padTooLong, withLine } from './pad-text.js'
import manifest from './seti-mod.json' with { type: 'json' }

const KEY = 'text'

const TOO_LONG = `The pad holds at most ${PAD_MAX.toLocaleString('en')} characters`

const stored = async (api: ServerModApi): Promise<string> => {
  const value = await api.storage.get(KEY)
  return typeof value === 'string' ? value : ''
}

const sentText = (body: unknown): unknown =>
  typeof body === 'object' && body !== null ? (body as { text?: unknown }).text : undefined

/** Replaces the pad with what the user's device sends; only the user's own devices write it whole. */
async function save(api: ServerModApi, { caller, body }: ModRequest): Promise<ModResponse> {
  if (caller.source !== 'user') {
    return { status: 403, body: 'Only the user edits the pad; the EA adds to it with Add to pad' }
  }
  const text = sentText(body)
  if (typeof text !== 'string') {
    return { status: 400, body: 'Send the pad as { "text": "..." }' }
  }
  if (padTooLong(text)) {
    return { status: 422, body: TOO_LONG }
  }
  await api.storage.set(KEY, text)
  return { body: { text } }
}

/** Keeps the pad's text in the mod's storage: the user's devices replace it, the EA adds lines. */
export const textPadServer = defineMod({
  manifest,
  server: (api) => {
    api.route('GET', '/text', async ({ caller }) =>
      caller.source === 'agent'
        ? { status: 403, body: 'Agents do not read the pad' }
        : { body: { text: await stored(api) } },
    )
    api.route('PUT', '/text', async (request) => save(api, request))
    api.registerCommand('read', async () => {
      const text = await stored(api)
      return { text: text === '' ? 'The pad is empty.' : `The user's pad holds:\n${text}` }
    })
    api.registerCommand('append', async ({ args }) => {
      const line = typeof args.line === 'string' ? args.line.trim() : ''
      if (line === '') {
        throw new Error('Give the line to add')
      }
      const text = withLine(await stored(api), line)
      if (padTooLong(text)) {
        throw new Error(`${TOO_LONG}, so the line does not fit`)
      }
      await api.storage.set(KEY, text)
      await api.audit('appended', 'Added a line to the pad', { characters: line.length })
      return { text: 'Added the line to the pad.' }
    })
  },
})
