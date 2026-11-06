import { awsSettingsInput, type AwsSettingsInput, type CredentialProfile } from '@seti/shared'
import { Save } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPut, errorText } from '@/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useLeaveGuard } from '@/hooks/useLeaveGuard'
import { SettingRow, SettingsCard } from '../layout'

interface Form {
  role: string
  externalId: string
  region: string
  minutes: string
}

const toForm = ({ aws }: CredentialProfile): Form => ({
  role: aws.role_arn ?? '',
  externalId: aws.external_id ?? '',
  region: aws.region,
  minutes: String(aws.session_minutes),
})

interface FieldText {
  placeholder: string
  description: string
  unit?: string
}

const sameForm = (a: Form, b: Form) =>
  a.role === b.role && a.externalId === b.externalId && a.region === b.region && a.minutes === b.minutes

const HOST_ROLE_PLACEHOLDER = 'arn:aws:iam::<account>:role/<the role this machine runs as>'

const DENIED = [
  'secretsmanager:GetSecretValue',
  'ssm:GetParameter*',
  's3:GetObject*',
  'kms:Decrypt',
  'ecr:GetAuthorizationToken',
  'ecs:ExecuteCommand',
]

function trustPolicy(hostRole: string, externalId: string): string {
  const statement: Record<string, unknown> = {
    Effect: 'Allow',
    Principal: { AWS: hostRole },
    Action: 'sts:AssumeRole',
  }
  if (externalId !== '') {
    statement.Condition = { StringEquals: { 'sts:ExternalId': externalId } }
  }
  return JSON.stringify({ Version: '2012-10-17', Statement: [statement] }, null, 2)
}

const denyPolicy = () =>
  JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Deny', Action: DENIED, Resource: '*' }] }, null, 2)

function Code({ label, text }: { label: string; text: string }) {
  return (
    <pre
      aria-label={label}
      className="max-h-72 overflow-auto bg-muted p-2 font-mono text-2xs break-all whitespace-pre-wrap"
    >
      {text}
    </pre>
  )
}

/** The IAM role to create, for the user to pass on to whoever administers the AWS account. */
function IamSetup({ hostRole, externalId }: { hostRole: string | null; externalId: string }) {
  return (
    <details className="border-t border-border">
      <summary className="cursor-pointer px-3 py-2 font-medium">IAM setup</summary>
      <div className="space-y-2 px-3 pb-3 text-muted-foreground">
        <p>
          Create a role such as <span className="font-mono text-foreground">seti-agent-readonly</span> with a maximum
          session of at least the session length above, and this trust policy:
        </p>
        <Code label="Trust policy" text={trustPolicy(hostRole ?? HOST_ROLE_PLACEHOLDER, externalId)} />
        <p>
          Attach the AWS managed policies <span className="font-mono text-foreground">ViewOnlyAccess</span> and{' '}
          <span className="font-mono text-foreground">CloudWatchLogsReadOnlyAccess</span>. ViewOnlyAccess lists and
          describes resources without reading their data; the logs policy lets agents read log events for debugging.
          Avoid <span className="font-mono text-foreground">ReadOnlyAccess</span>: it also reads data, such as S3 object
          contents, DynamoDB items and SSM parameter values. An inline deny keeps secrets out even if broader policies
          are attached later:
        </p>
        <Code label="Deny policy" text={denyPolicy()} />
      </div>
    </details>
  )
}

/** The role a profile's agents with AWS on get short-lived credentials of. */
export function ProfileAws({
  profile,
  hostRole,
  onChanged,
}: {
  profile: CredentialProfile
  hostRole: string | null
  onChanged: () => void
}) {
  const [form, setForm] = useState<Form>(() => toForm(profile))
  const [saving, setSaving] = useState(false)
  const dirty = !sameForm(form, toForm(profile))
  useLeaveGuard(dirty)
  const patch = (next: Partial<Form>) => {
    setForm((prev) => ({ ...prev, ...next }))
  }

  const save = async () => {
    const input: AwsSettingsInput = {
      role_arn: form.role.trim() === '' ? null : form.role,
      external_id: form.externalId.trim() === '' ? null : form.externalId,
      region: form.region,
      session_minutes: Number(form.minutes),
    }
    const parsed = awsSettingsInput.safeParse(input)
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Check the settings')
      return
    }
    setSaving(true)
    try {
      await apiPut<CredentialProfile>(`/credentials/profiles/${profile.id}/aws`, parsed.data)
      toast.success('AWS role saved')
      onChanged()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  const configured = profile.aws.role_arn !== null
  const field = (label: string, key: keyof Form, { placeholder, description, unit }: FieldText) => (
    <SettingRow label={label} stack description={description}>
      <Input
        aria-label={label}
        className={unit === undefined ? 'w-80 font-mono max-md:w-full' : 'w-24 font-mono'}
        placeholder={placeholder}
        value={form[key]}
        onChange={(event) => {
          patch({ [key]: event.target.value })
        }}
      />
      {unit !== undefined && <span className="text-muted-foreground">{unit}</span>}
    </SettingRow>
  )

  return (
    <SettingsCard
      title="AWS role"
      actions={
        <Button size="sm" onClick={() => void save()} disabled={!dirty || saving}>
          <Save />
          {saving ? 'Saving...' : 'Save'}
        </Button>
      }
    >
      <SettingRow
        label="Status"
        description={
          configured
            ? 'Agents with AWS on get short-lived credentials of this role through their sandbox proxy.'
            : 'Not configured: agents with AWS on get no credentials until a role is set.'
        }
      >
        <span className="font-medium">{configured ? 'Configured' : 'Not configured'}</span>
      </SettingRow>
      {field('Role ARN', 'role', {
        placeholder: 'arn:aws:iam::123456789012:role/seti-agent-readonly',
        description: 'The role Seti assumes.',
      })}
      {field('External ID', 'externalId', {
        placeholder: 'Optional',
        description: 'Sent with AssumeRole when the trust policy asks for one.',
      })}
      {field('Region', 'region', {
        placeholder: 'us-east-1',
        description: 'AWS_REGION inside the sandbox, and where STS is called.',
      })}
      {field('Session length', 'minutes', {
        placeholder: '60',
        description: '15 to 720 minutes, and no more than the role allows.',
        unit: 'minutes',
      })}
      <IamSetup hostRole={hostRole} externalId={form.externalId.trim()} />
    </SettingsCard>
  )
}
