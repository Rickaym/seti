import {
  permissionPolicySchema,
  permissionRequestsSchema,
  type BuiltInScope,
  type PermissionPolicy,
  type PermissionRequest,
} from '@seti/shared'
import { Hand } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { apiGetValid, errorText } from '@/api'
import { useTasks } from '@/hooks/useTasks'
import { navigate } from '@/lib/route'
import { toolLabel } from '@/lib/tool-label'
import { InheritedRules, RuleEditor, RuleGroups } from './PermissionRules'
import { SettingsBody, SettingsCard, SettingsHeader } from './layout'

const APPLIES: Record<BuiltInScope, string> = {
  all: 'every agent',
  sandboxed: 'sandboxed',
  unsandboxed: 'unsandboxed',
}

function Waiting({ requests }: { requests: readonly PermissionRequest[] }) {
  const titles = new Map(useTasks().tasks.map((task) => [task.id, task.title]))
  return (
    <SettingsCard title="Waiting for you">
      <ul>
        {requests.map((request) => (
          <li key={request.id} className="border-b border-border last:border-b-0">
            <button
              type="button"
              className="flex min-h-9 w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted pointer-coarse:min-h-11"
              onClick={() => {
                navigate('agents', request.task_id)
              }}
            >
              <Hand className="size-3.5 shrink-0 text-warning-text" aria-hidden />
              <span className="shrink-0 font-medium">{titles.get(request.task_id) ?? 'Agent'}</span>
              <span className="min-w-0 truncate text-muted-foreground">
                {toolLabel(request.tool_name)}: {request.summary}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </SettingsCard>
  )
}

/** Allow, ask and deny rules for every agent, what Seti applies on its own, and what waits. */
export function PermissionsPage() {
  const [policy, setPolicy] = useState<PermissionPolicy | null>(null)
  const [waiting, setWaiting] = useState<readonly PermissionRequest[]>([])
  const [error, setError] = useState('')

  const load = useCallback(() => {
    Promise.all([
      apiGetValid('/permissions', permissionPolicySchema),
      apiGetValid('/permissions/requests', permissionRequestsSchema),
    ])
      .then(([nextPolicy, requests]) => {
        setPolicy(nextPolicy)
        setWaiting(requests)
        setError('')
      })
      .catch((e: unknown) => {
        setError(errorText(e))
      })
  }, [])

  useEffect(load, [load])

  const header = (
    <SettingsHeader
      title="Permissions"
      description="Agents edit in their own directories and use the tools these rules allow. A classifier allows or turns down other calls, and one it cannot decide waits for you. Deny beats ask, and ask beats allow."
    />
  )
  if (policy === null) {
    return (
      <SettingsBody narrow header={header}>
        <p className={error === '' ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'}>
          {error === '' ? 'Loading...' : error}
        </p>
      </SettingsBody>
    )
  }
  return (
    <SettingsBody narrow header={header}>
      <div className="flex flex-col gap-4">
        {waiting.length > 0 && <Waiting requests={waiting} />}
        <SettingsCard title="Global rules">
          <RuleEditor
            rules={policy.rules}
            path="/permissions/rules"
            empty="No rules yet. Always allow on a request adds one, or add one here."
            onChange={load}
          />
        </SettingsCard>
        {policy.inherited.length > 0 && (
          <SettingsCard title="Claude Code rules">
            <InheritedRules rules={policy.inherited} />
          </SettingsCard>
        )}
        <SettingsCard title="Always refused">
          <ul className="list-disc py-2 pr-3 pl-7 text-muted-foreground">
            {policy.guards.map((guard) => (
              <li key={guard} className="py-0.5">
                {guard}
              </li>
            ))}
          </ul>
        </SettingsCard>
        <SettingsCard title="Built-in rules">
          <RuleGroups
            label="Built-in rules"
            entries={policy.built_in.map((rule) => ({
              key: `${rule.behavior} ${rule.rule} ${rule.applies}`,
              behavior: rule.behavior,
              rule: rule.rule,
              note: APPLIES[rule.applies],
            }))}
          />
        </SettingsCard>
      </div>
    </SettingsBody>
  )
}
