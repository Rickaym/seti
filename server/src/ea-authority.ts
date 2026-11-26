import { createHmac, randomBytes } from 'node:crypto'
import {
  isPlanRequest,
  readsBackWhole,
  type AnswerPermissionInput,
  type PermissionRequest,
  type Task,
} from '@seti/shared'
import type { Context } from 'hono'
import { fromEa, onUsersWord } from './ea-guard.js'
import { HttpError } from './http.js'
import { permissionRequests } from './store/permissions.js'

/** Keys this process's digests, so a digest reveals nothing of the redacted values in a call. */
const DIGEST_KEY = randomBytes(32)

/** Seti's fingerprint of what a held tool call or plan asks, down to its exact call. */
export async function requestDigest(request: PermissionRequest): Promise<string> {
  const exact = await permissionRequests.hashOf(request.id)
  const parts = [
    request.id,
    request.task_id,
    request.tool_name,
    request.kind,
    request.summary,
    request.input,
    request.description,
    request.reason,
    exact,
  ]
  return createHmac('sha256', DIGEST_KEY).update(JSON.stringify(parts)).digest('hex')
}

/**
 * The EA's answer to a held tool call or plan, on the user's word: Allow once, or Deny with
 * the user's message. Never Always, a rule for every agent or edited fields, and Allow only
 * for a plan or a call the EA could read back whole. Returns the question id the yes came
 * from, or null when the EA did not send the request.
 */
export async function eaAnswerOnWord(
  c: Context,
  task: Task,
  requestId: string,
  input: AnswerPermissionInput,
): Promise<number | null> {
  if (!fromEa()) {
    return null
  }
  if (input.decision === 'always' || input.scope === 'global') {
    throw new HttpError(403, "The EA cannot always allow a call; a rule is the user's to add, in Seti")
  }
  if (input.fields !== undefined) {
    throw new HttpError(403, 'The EA cannot edit a call; the user does that in Seti')
  }
  const request = await permissionRequests.get(requestId)
  if (request?.task_id !== task.id) {
    throw new HttpError(404, 'No such permission request')
  }
  if (input.decision === 'allow' && !isPlanRequest(request) && !readsBackWhole(request.input)) {
    throw new HttpError(403, 'This call is too long for the EA to read back whole; the user allows it in Seti')
  }
  const expected = {
    request: request.id,
    digest: await requestDigest(request),
    decision: input.decision,
    message: input.message ?? '',
  }
  return onUsersWord(c, 'answer_question', expected)
}
