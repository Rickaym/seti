import type { RpcCall } from '../json-rpc.js'

/**
 * Notifications Seti asks Codex not to send. `remoteControl/status/changed` carries the host's
 * name and an installation id; remote control itself needs a ChatGPT sign-in no agent has. The
 * streamed parts of items and the turn's running diff would be stored as rows of their own; the
 * completed item carries the same text.
 */
export const OPTED_OUT: readonly string[] = [
  'remoteControl/status/changed',
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'item/commandExecution/outputDelta',
  'item/commandExecution/terminalInteraction',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'item/mcpToolCall/progress',
  'turn/diff/updated',
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The remote's address without a user name or password in it. */
function bareUrl(url: unknown): unknown {
  if (typeof url !== 'string' || !URL.canParse(url)) {
    return url
  }
  const parsed = new URL(url)
  if (parsed.username === '' && parsed.password === '') {
    return url
  }
  parsed.username = ''
  parsed.password = ''
  return parsed.toString()
}

/** A thread as Seti keeps it: without its rollout file's path in Codex's home. */
function keptThread(thread: Record<string, unknown>): Record<string, unknown> {
  const rest = Object.fromEntries(Object.entries(thread).filter(([key]) => key !== 'path'))
  const { gitInfo } = thread
  return isRecord(gitInfo) ? { ...rest, gitInfo: { ...gitInfo, originUrl: bareUrl(gitInfo.originUrl) } } : rest
}

/** A body that may hold a thread (a notification's params or a reply), as Seti keeps it. */
export function kept(body: unknown): unknown {
  return isRecord(body) && isRecord(body.thread) ? { ...body, thread: keptThread(body.thread) } : body
}

/** The message as Seti stores it. */
export function keptMessage(message: RpcCall): RpcCall {
  return message.params === undefined ? message : { ...message, params: kept(message.params) }
}
