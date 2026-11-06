import { agentPermissionsSchema, type AgentPermissions as Permissions, type Task } from '@seti/shared'
import { useCallback, useEffect, useState } from 'react'
import { apiGetValid, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { InfoTip } from '@/components/InfoTip'
import { SettingsLink } from '@/components/SettingsLink'
import { InheritedRules, RuleEditor } from '@/panels/settings/PermissionRules'

/** The agent's own permission rules, on top of the ones for every agent in Settings. */
export function AgentPermissions({ task }: { task: Task }) {
  const { id: taskId, permission_mode: mode } = task
  const [permissions, setPermissions] = useState<Permissions | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    apiGetValid(`/tasks/${taskId}/permissions`, agentPermissionsSchema)
      .then((loaded) => {
        setPermissions(loaded)
        setError('')
      })
      .catch((e: unknown) => {
        setError(errorText(e))
      })
  }, [taskId])

  useEffect(load, [load])

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
        <SettingsLink page="permissions">Global rules</SettingsLink>
        <InfoTip label="About rules" text="This agent's own rules add to the global rules every agent follows." />
        {mode !== null && (
          <Hint text="Claude Code permission mode of the latest session">
            <span className="ml-auto font-mono text-2xs">{mode}</span>
          </Hint>
        )}
      </div>
      {error !== '' && <p className="text-destructive">{error}</p>}
      {permissions !== null && (
        <div className="border border-border">
          <RuleEditor
            rules={permissions.own}
            path={`/tasks/${taskId}/permissions/rules`}
            empty="No rules of its own."
            onChange={load}
          />
        </div>
      )}
      {permissions !== null && permissions.project.length > 0 && (
        <div className="border border-border">
          <InheritedRules rules={permissions.project} />
        </div>
      )}
    </div>
  )
}
