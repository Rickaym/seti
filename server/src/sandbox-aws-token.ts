import { randomBytes } from 'node:crypto'

const awsTokens = new Map<string, string>()

/** The task's AWS container authorization token, the same for its proxy and its processes. */
export function awsToken(taskId: string): string {
  let token = awsTokens.get(taskId)
  if (token === undefined) {
    token = randomBytes(24).toString('base64url')
    awsTokens.set(taskId, token)
  }
  return token
}

/** Forgets a deleted task's token. */
export function forgetAwsToken(taskId: string): void {
  awsTokens.delete(taskId)
}
