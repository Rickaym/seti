import type { ModDetail, ModInfo } from '@seti/shared'
import { Settings2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { navigate } from '@/lib/route'
import { settingsPages } from '../pages'
import { ContributesTab } from './ContributesTab'
import { ModFacts } from './ModIdentity'
import { ModLog } from './ModLog'
import { ModMarkdown } from './ModMarkdown'
import { ModSettingsCards, ModSettingsPage } from './ModSettingsPage'
import { PermissionsTab } from './PermissionsTab'
import { UpdateSettings } from './UpdatePanel'
import { TAB_LABELS, tabsOf, type TabKey } from './mod-list'
import { modSettingsKey } from './mod-settings-key'
import { useModSettingsSave } from './use-mod-settings-save'

function SettingsTab({ mod, detail, onDetail }: { mod: ModInfo; detail: ModDetail; onDetail: (d: ModDetail) => void }) {
  const save = useModSettingsSave(mod.id, onDetail)
  const own = settingsPages.get(modSettingsKey(mod.id))
  if (own?.view !== undefined && own.view !== ModSettingsPage) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          navigate('settings', own.key)
        }}
      >
        <Settings2 />
        Open settings
      </Button>
    )
  }
  return <ModSettingsCards detail={detail} save={save} />
}

function VersionsTab({ mod }: { mod: ModInfo }) {
  const install = mod.install
  if (install === null) {
    return null
  }
  return (
    <div className="max-w-[72ch] space-y-4">
      {install.last_error !== null && <p className="text-destructive">{install.last_error}</p>}
      <UpdateSettings mod={mod} install={install} />
      <ModLog id={mod.id} />
    </div>
  )
}

const Loading = () => <p className="text-muted-foreground">Loading...</p>

/** A mod's tabs: its README, permissions, settings, what it adds, changelog and versions. */
export function ModTabs({
  mod,
  detail,
  isolated,
  tab,
  onTab,
  onDetail,
}: {
  mod: ModInfo
  detail: ModDetail | null
  isolated: boolean
  tab: string
  onTab: (tab: string) => void
  onDetail: (detail: ModDetail) => void
}) {
  const panels: Record<TabKey, ReactNode> = {
    details: (
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_13rem]">
        <div className="min-w-0">
          {detail === null ? <Loading /> : <ModMarkdown text={detail.readme} empty="This mod has no README." />}
        </div>
        <aside className="md:border-l md:border-border md:pl-5">
          <ModFacts mod={mod} />
        </aside>
      </div>
    ),
    permissions: <PermissionsTab mod={mod} isolated={isolated} />,
    settings: detail === null ? <Loading /> : <SettingsTab mod={mod} detail={detail} onDetail={onDetail} />,
    contributes: <ContributesTab manifest={mod.manifest} />,
    changelog:
      detail === null ? <Loading /> : <ModMarkdown text={detail.changelog} empty="This mod has no changelog." />,
    versions: <VersionsTab mod={mod} />,
  }
  return (
    <Tabs value={tab} onValueChange={onTab} className="gap-4">
      <div className="-mx-1 overflow-x-auto border-b border-border px-1 [scrollbar-width:none]">
        <TabsList variant="line" aria-label={`${mod.display_name} tabs`} className="h-9">
          {tabsOf(mod).map((key) => (
            <TabsTrigger key={key} value={key} className="flex-none px-2.5">
              {TAB_LABELS[key]}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {tabsOf(mod).map((key) => (
        <TabsContent key={key} value={key}>
          {panels[key]}
        </TabsContent>
      ))}
    </Tabs>
  )
}
