import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AWS_CREDENTIALS_PATH } from '@seti/shared'
import type { ContainerCredentials } from './aws-credentials.js'

/** A task's AWS, as its egress proxy serves it. */
export interface EgressAws {
  /** Whether the task has AWS on now; read for every request. */
  enabled: () => Promise<boolean>
  /** The value the task's AWS_CONTAINER_AUTHORIZATION_TOKEN holds. */
  token: string
  /** Credentials of the set's role, or null when no role is configured. */
  credentials: () => Promise<ContainerCredentials | null>
}

export const isAwsCredentialsPath = (url: string) =>
  url === AWS_CREDENTIALS_PATH || url.startsWith(`${AWS_CREDENTIALS_PATH}?`)

/** AWS service endpoints, which sandboxed tasks with AWS on reach without TLS interception. */
export const isAwsHost = (host: string) => host.endsWith('.amazonaws.com')

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function sameToken(sent: string | undefined, token: string): boolean {
  const a = Buffer.from(sent ?? '')
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Answers the AWS container credentials endpoint for a task: its set's role's credentials
 * when the task has AWS on and sends its own authorization token, else an error the CLI shows.
 */
export async function serveAwsCredentials(
  req: IncomingMessage,
  res: ServerResponse,
  aws: EgressAws | undefined,
): Promise<void> {
  req.resume()
  if (aws === undefined || !(await aws.enabled().catch(() => false))) {
    json(res, 404, { message: 'Seti: AWS is off for this agent. Ask the user to turn it on for the task.' })
    return
  }
  if (!sameToken(req.headers.authorization, aws.token)) {
    json(res, 401, { message: 'Seti: wrong AWS container authorization token' })
    return
  }
  let credentials: ContainerCredentials | null
  try {
    credentials = await aws.credentials()
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    json(res, 502, { message: `Seti could not assume the AWS role: ${reason}` })
    return
  }
  if (credentials === null) {
    json(res, 503, {
      message: 'Seti: AWS is not configured. Ask the user to set a role in its credential, in Settings, Credentials.',
    })
    return
  }
  json(res, 200, credentials)
}
