import type { EaAction } from '@seti/shared'

interface ItemBase {
  id: number
  at: number
}

export interface SpeechItem extends ItemBase {
  kind: 'user' | 'bot'
  text: string
  final: boolean
}

export interface ActionItem extends ItemBase {
  kind: 'action'
  tool: string
  callId: string | null
  /** Null until the bot reports what the call did. */
  summary: string | null
  /** Null while the call runs or when it ended without a report. */
  ok: boolean | null
  running: boolean
}

interface MarkerItem extends ItemBase {
  kind: 'marker'
  text: string
  /** More about the divider, such as the summary text behind a compaction. */
  detail?: string
}

export type CaptionItem = SpeechItem | ActionItem | MarkerItem

/** segments: spoken text of the open bot caption; shown: what closed captions already showed. */
export interface CaptionState {
  items: CaptionItem[]
  nextId: number
  segments: ReadonlyMap<number, string>
  shown: ReadonlyMap<number, string>
}

export type CaptionEvent =
  | { type: 'user'; text: string; final: boolean; at: number }
  | { type: 'bot-segment'; segment: number; spoken: string; at: number }
  | { type: 'bot-started' }
  | { type: 'bot-stopped' }
  | { type: 'call-started'; tool: string; callId: string; at: number }
  | { type: 'call-stopped'; tool: string; callId: string; cancelled: boolean }
  | { type: 'action'; action: EaAction; at: number }
  | { type: 'marker'; text: string; at: number }

export const initialCaptions: CaptionState = { items: [], nextId: 1, segments: new Map(), shown: new Map() }

const lastIndex = <T>(items: readonly T[], test: (item: T) => boolean) => items.findLastIndex(test)

const replaceAt = (items: readonly CaptionItem[], index: number, item: CaptionItem) =>
  items.map((existing, i) => (i === index ? item : existing))

type NewItem = Omit<SpeechItem, 'id'> | Omit<ActionItem, 'id'> | Omit<MarkerItem, 'id'>

function append(state: CaptionState, item: NewItem): CaptionState {
  return { ...state, items: [...state.items, { ...item, id: state.nextId }], nextId: state.nextId + 1 }
}

/** The bot caption still being spoken; actions and markers between sentences do not close it. */
function openBotIndex(items: readonly CaptionItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item?.kind === 'bot') {
      return item.final ? -1 : i
    }
    if (item?.kind === 'user') {
      return -1
    }
  }
  return -1
}

function user(state: CaptionState, text: string, final: boolean, at: number): CaptionState {
  if (text.trim() === '') {
    return state
  }
  const index = lastIndex(state.items, (item) => item.kind === 'user')
  const last = state.items[index]
  if (last?.kind === 'user' && !last.final) {
    return { ...state, items: replaceAt(state.items, index, { ...last, text, final }) }
  }
  return append(state, { kind: 'user', text, final, at })
}

/** The part of a segment's spoken text that no earlier caption showed. */
const unseen = (spoken: string, shown: string) => (spoken.startsWith(shown) ? spoken.slice(shown.length) : spoken)

/** Progress on a segment of a caption that already ended extends that caption. */
function extendClosed(state: CaptionState, segment: number, spoken: string): CaptionState | null {
  const previous = state.shown.get(segment)
  const index = lastIndex(state.items, (item) => item.kind === 'user' || item.kind === 'bot')
  const last = state.items[index]
  if (previous === undefined || state.segments.has(segment) || last?.kind !== 'bot') {
    return null
  }
  const extra = unseen(spoken, previous).trim()
  if (extra === '') {
    return state
  }
  const items = replaceAt(state.items, index, { ...last, text: `${last.text} ${extra}` })
  return { ...state, items, shown: new Map(state.shown).set(segment, spoken) }
}

function botSegment(state: CaptionState, segment: number, spoken: string, at: number): CaptionState {
  if (openBotIndex(state.items) === -1) {
    const extended = extendClosed(state, segment, spoken)
    if (extended !== null) {
      return extended
    }
  }
  const segments = new Map(state.segments).set(segment, spoken)
  const text = [...segments]
    .map(([id, raw]) => unseen(raw, state.shown.get(id) ?? '').trim())
    .filter((part) => part !== '')
    .join(' ')
  if (text === '') {
    return state
  }
  const index = openBotIndex(state.items)
  const open = state.items[index]
  if (open?.kind === 'bot') {
    return { ...state, segments, items: replaceAt(state.items, index, { ...open, text }) }
  }
  return { ...append(state, { kind: 'bot', text, final: false, at }), segments }
}

/** Ends the open bot caption; its segments count as shown from here on. */
function closeBot(state: CaptionState): CaptionState {
  const shown = new Map(state.shown)
  for (const [id, raw] of state.segments) {
    shown.set(id, raw)
  }
  const index = openBotIndex(state.items)
  const open = state.items[index]
  const items = open?.kind === 'bot' ? replaceAt(state.items, index, { ...open, final: true }) : state.items
  return { ...state, items, segments: new Map(), shown }
}

/** The running call with this id, or the oldest running call of the tool when ids do not match. */
function runningIndex(items: readonly CaptionItem[], tool: string, callId: string): number {
  const byId = items.findIndex((item) => item.kind === 'action' && item.running && item.callId === callId)
  return byId === -1 ? items.findIndex((item) => item.kind === 'action' && item.running && item.tool === tool) : byId
}

function callStarted(state: CaptionState, tool: string, callId: string, at: number): CaptionState {
  const known = state.items.some((item) => item.kind === 'action' && item.callId === callId)
  return known ? state : append(state, { kind: 'action', tool, callId, summary: null, ok: null, running: true, at })
}

function callStopped(state: CaptionState, tool: string, callId: string, cancelled: boolean): CaptionState {
  const index = runningIndex(state.items, tool, callId)
  const item = state.items[index]
  if (item?.kind !== 'action') {
    return state
  }
  const ended: ActionItem = cancelled
    ? { ...item, running: false, ok: false, summary: 'Cancelled' }
    : { ...item, running: false }
  return { ...state, items: replaceAt(state.items, index, ended) }
}

/** Fills in the oldest call of that tool without a report, or adds the action on its own. */
function action(state: CaptionState, reported: EaAction, at: number): CaptionState {
  const index = state.items.findIndex(
    (item) => item.kind === 'action' && item.tool === reported.tool && item.summary === null,
  )
  const item = state.items[index]
  if (item?.kind !== 'action') {
    const { tool, summary, ok } = reported
    return append(state, { kind: 'action', tool, callId: null, summary, ok, running: false, at })
  }
  return { ...state, items: replaceAt(state.items, index, { ...item, summary: reported.summary, ok: reported.ok }) }
}

export function captionsReducer(state: CaptionState, event: CaptionEvent): CaptionState {
  switch (event.type) {
    case 'user':
      return user(state, event.text, event.final, event.at)
    case 'bot-segment':
      return botSegment(state, event.segment, event.spoken, event.at)
    case 'bot-started':
    case 'bot-stopped':
      return closeBot(state)
    case 'call-started':
      return callStarted(state, event.tool, event.callId, event.at)
    case 'call-stopped':
      return callStopped(state, event.tool, event.callId, event.cancelled)
    case 'action':
      return action(state, event.action, event.at)
    case 'marker':
      return append(closeBot(state), { kind: 'marker', text: event.text, at: event.at })
  }
}
