import { AWS_SETTINGS_DEFAULT, type AwsSettings } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { createAwsBroker, type AssumeRoleRequest, type ContainerCredentials } from './aws-credentials.js'

const ROLE = 'arn:aws:iam::123456789012:role/seti-agent-readonly'
const settings: AwsSettings = { ...AWS_SETTINGS_DEFAULT, role_arn: ROLE }
const HOUR = 3_600_000

function fakeSts(now: () => number) {
  const calls: AssumeRoleRequest[] = []
  const assume = async (request: AssumeRoleRequest): Promise<ContainerCredentials> => {
    calls.push(request)
    await Promise.resolve()
    return {
      AccessKeyId: `ASIA${String(calls.length)}`,
      SecretAccessKey: 'fake-secret',
      Token: 'fake-session',
      Expiration: new Date(now() + request.seconds * 1000).toISOString(),
    }
  }
  return { calls, assume }
}

describe('createAwsBroker', () => {
  it('gives nothing without a role and never calls STS', async () => {
    const sts = fakeSts(Date.now)
    const broker = createAwsBroker(sts.assume)
    expect(await broker.credentials(AWS_SETTINGS_DEFAULT)).toBeNull()
    expect(sts.calls).toEqual([])
  })

  it('assumes the role once for concurrent callers and serves the cache until near expiry', async () => {
    let clock = Date.parse('2026-09-29T12:00:00Z')
    const now = () => clock
    const sts = fakeSts(now)
    const broker = createAwsBroker(sts.assume, now)
    const withId = { ...settings, external_id: 'seti-external', session_minutes: 60 }
    const [a, b] = await Promise.all([broker.credentials(withId), broker.credentials(withId)])
    expect(a?.AccessKeyId).toBe('ASIA1')
    expect(b?.AccessKeyId).toBe('ASIA1')
    expect(sts.calls).toEqual([{ roleArn: ROLE, externalId: 'seti-external', region: 'us-east-1', seconds: 3600 }])
    clock += HOUR - 10 * 60_000
    expect((await broker.credentials(withId))?.AccessKeyId).toBe('ASIA1')
    clock += 6 * 60_000
    expect((await broker.credentials(withId))?.AccessKeyId).toBe('ASIA2')
    expect(sts.calls).toHaveLength(2)
    expect((await broker.credentials({ ...withId, region: 'eu-west-1' }))?.AccessKeyId).toBe('ASIA3')
  })

  it('does not keep a failed AssumeRole, so the next request tries again', async () => {
    let fail = true
    const sts = fakeSts(Date.now)
    const broker = createAwsBroker(async (request) => {
      if (fail) {
        throw new Error('User is not authorized to perform: sts:AssumeRole')
      }
      return sts.assume(request)
    })
    await expect(broker.credentials(settings)).rejects.toThrow(/not authorized/)
    fail = false
    expect((await broker.credentials(settings))?.AccessKeyId).toBe('ASIA1')
  })
})
