import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import type { AwsSettings } from '@seti/shared'

/** Credentials are handed out until this long before they expire, then replaced. */
const REFRESH_MARGIN_MS = 5 * 60_000
const STS_TIMEOUT_MS = 15_000
const SESSION_NAME = 'seti-agent'

/** What an AWS container credentials endpoint returns, which the CLI and SDKs read. */
export interface ContainerCredentials {
  AccessKeyId: string
  SecretAccessKey: string
  Token: string
  Expiration: string
}

export interface AssumeRoleRequest {
  roleArn: string
  externalId: string | null
  region: string
  seconds: number
}

export type AssumeRole = (request: AssumeRoleRequest) => Promise<ContainerCredentials>

/** Assumes the role with this machine's default credentials, the EC2 instance role on the host. */
const stsAssumeRole: AssumeRole = async (request) => {
  const client = new STSClient({ region: request.region })
  try {
    const out = await client.send(
      new AssumeRoleCommand({
        RoleArn: request.roleArn,
        RoleSessionName: SESSION_NAME,
        DurationSeconds: request.seconds,
        ...(request.externalId === null ? {} : { ExternalId: request.externalId }),
      }),
      { abortSignal: AbortSignal.timeout(STS_TIMEOUT_MS) },
    )
    const creds = out.Credentials
    if (creds?.AccessKeyId === undefined || creds.SecretAccessKey === undefined || creds.SessionToken === undefined) {
      throw new Error('STS answered AssumeRole without credentials')
    }
    return {
      AccessKeyId: creds.AccessKeyId,
      SecretAccessKey: creds.SecretAccessKey,
      Token: creds.SessionToken,
      Expiration: (creds.Expiration ?? new Date(Date.now() + request.seconds * 1000)).toISOString(),
    }
  } finally {
    client.destroy()
  }
}

export interface AwsBroker {
  /** Credentials of the configured role, or null when no role is configured. */
  credentials: (settings: AwsSettings) => Promise<ContainerCredentials | null>
}

/** Hands sandboxes short-lived credentials of their set's role, one STS call per role and hour. */
export function createAwsBroker(assume: AssumeRole = stsAssumeRole, now: () => number = Date.now): AwsBroker {
  const cache = new Map<string, Promise<ContainerCredentials>>()
  const fresh = (creds: ContainerCredentials) => Date.parse(creds.Expiration) - REFRESH_MARGIN_MS > now()

  return {
    credentials: async (settings) => {
      if (settings.role_arn === null) {
        return null
      }
      const request: AssumeRoleRequest = {
        roleArn: settings.role_arn,
        externalId: settings.external_id,
        region: settings.region,
        seconds: settings.session_minutes * 60,
      }
      const key = JSON.stringify(request)
      const cached = cache.get(key)
      const creds = cached === undefined ? null : await cached.catch(() => null)
      if (creds !== null && fresh(creds)) {
        return creds
      }
      const current = cache.get(key)
      if (current !== undefined && current !== cached) {
        return current
      }
      const pending = assume(request)
      cache.set(key, pending)
      pending.catch(() => {
        if (cache.get(key) === pending) {
          cache.delete(key)
        }
      })
      return pending
    },
  }
}

export const awsBroker = createAwsBroker()

let hostRole: Promise<string | null> | null = null
let settledHostRole: string | null = null

const HOST_ROLE_WAIT_MS = 3000

async function lookupHostRole(region: string): Promise<string | null> {
  const client = new STSClient({ region })
  try {
    const { Arn } = await client.send(new GetCallerIdentityCommand({}), {
      abortSignal: AbortSignal.timeout(STS_TIMEOUT_MS),
    })
    const match = /^arn:(aws[\w-]*):sts::(\d{12}):assumed-role\/([^/]+)\//.exec(Arn ?? '')
    return match === null ? (Arn ?? null) : `arn:${match[1] ?? 'aws'}:iam::${match[2] ?? ''}:role/${match[3] ?? ''}`
  } catch {
    return null
  } finally {
    client.destroy()
  }
}

async function startLookup(region: string): Promise<string | null> {
  settledHostRole = await lookupHostRole(region)
  return settledHostRole
}

/** The host role if the lookup has finished, without waiting; starts the lookup when needed. */
export function knownHostRole(region: string): string | null {
  hostRole ??= startLookup(region)
  return settledHostRole
}

/**
 * The IAM role this machine runs as, which an agent role's trust policy names, looked up
 * once with STS GetCallerIdentity; null when unknown or still being looked up after a short wait.
 */
export async function awsHostRole(region: string): Promise<string | null> {
  hostRole ??= startLookup(region)
  const wait = new Promise<null>((resolve) => setTimeout(resolve, HOST_ROLE_WAIT_MS, null).unref())
  return Promise.race([hostRole, wait])
}
