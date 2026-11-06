import { DefaultSwitch } from '@/panels/access/DefaultSwitch'
import { useAccessCatalog } from '@/panels/access/access'
import { SettingsCard } from '../layout'

/** Whether sandboxed agents get AWS without choosing it in their settings. */
export function AwsDefault() {
  const { catalog, saveDefault } = useAccessCatalog()
  const aws = catalog?.find((item) => item.kind === 'aws')
  return (
    <SettingsCard
      title="AWS access"
      actions={
        aws === undefined ? undefined : (
          <DefaultSwitch name={aws.name} enabled={aws.default_enabled} onChange={(on) => void saveDefault(aws, on)} />
        )
      }
    >
      <p className="p-3 text-muted-foreground">
        AWS for agents that do not choose: short-lived keys for the role in each agent&apos;s credential. Picking a
        credential with a role turns AWS on for that agent.
      </p>
    </SettingsCard>
  )
}
