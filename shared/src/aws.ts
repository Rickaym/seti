import { z } from 'zod'

const ROLE_ARN = /^arn:aws(-cn|-us-gov)?:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/
const EXTERNAL_ID = /^[\w+=,.@:/-]{2,1224}$/
const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d{1,2}$/

/** A role ARN's name, such as agent-dev for arn:aws:iam::123456789012:role/agent-dev. */
export const awsRoleName = (arn: string) => arn.slice(arn.lastIndexOf('/') + 1)

/** The role Seti assumes for sandboxed agents with AWS on; not secret, but audited. */
export const awsSettingsInput = z.object({
  role_arn: z
    .string()
    .trim()
    .regex(ROLE_ARN, 'Use a role ARN such as arn:aws:iam::123456789012:role/seti-agent-readonly')
    .nullable(),
  external_id: z
    .string()
    .trim()
    .regex(EXTERNAL_ID, 'External IDs are 2 to 1224 letters, digits or +=,.@:/-')
    .nullable(),
  region: z.string().trim().regex(REGION, 'Use a region such as us-east-1'),
  session_minutes: z.number().int().min(15).max(720),
})
export type AwsSettingsInput = z.input<typeof awsSettingsInput>

export interface AwsSettings extends z.output<typeof awsSettingsInput> {
  updated_at: string | null
}

export const AWS_SETTINGS_DEFAULT: AwsSettings = {
  role_arn: null,
  external_id: null,
  region: 'us-east-1',
  session_minutes: 60,
  updated_at: null,
}

export interface AwsStatus {
  settings: AwsSettings
  /** The role this machine runs as, which the trust policy names; null when unknown. */
  host_role: string | null
}

/** Where sandboxed AWS tools fetch credentials, on the task's proxy inside the sandbox. */
export const AWS_CREDENTIALS_PATH = '/seti/aws-credentials'
