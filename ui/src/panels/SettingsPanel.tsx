import { ChevronRight } from 'lucide-react'
import { useId, useSyncExternalStore, type ReactElement } from 'react'
import { NewsDot } from '@/components/NewsDot'
import { DetailPane, ListPane } from '@/components/SplitPane'
import { useNarrow } from '@/hooks/useMedia'
import { useNewsPages } from '@/lib/mod-views'
import { PANES } from '@/lib/pane-size'
import { navigate } from '@/lib/route'
import { cn } from '@/lib/utils'
import { AboutPage } from '@/panels/settings/AboutPage'
import { AccountPage } from '@/panels/settings/AccountPage'
import { AgentsPage } from '@/panels/settings/AgentsPage'
import { AuditPage } from '@/panels/settings/AuditPage'
import { CapabilitiesPages } from '@/panels/settings/CapabilitiesPages'
import { ChannelsPage } from '@/panels/settings/ChannelsPage'
import { EaPage } from '@/panels/settings/EaPage'
import { GeneralPage } from '@/panels/settings/GeneralPage'
import { NotificationsPage } from '@/panels/settings/NotificationsPage'
import { PermissionsPage } from '@/panels/settings/PermissionsPage'
import { ReposPage } from '@/panels/settings/ReposPage'
import { ResourcesPage } from '@/panels/settings/ResourcesPage'
import { SandboxPage } from '@/panels/settings/SandboxPage'
import { SharingPage } from '@/panels/settings/SharingPage'
import { SignInPage } from '@/panels/settings/SignInPage'
import { ConnectionsPage } from '@/panels/settings/connections/ConnectionsPage'
import { CredentialSetsPage } from '@/panels/settings/credentials/CredentialSetsPage'
import { ModsPage } from '@/panels/settings/mods/ModsPage'
import {
  isProbedPage,
  isSettingsPage,
  settingsPages,
  useSettingsGroups,
  type ProbedPageKey,
  type SettingsPageKey,
} from '@/panels/settings/pages'
import { SshPage } from '@/panels/settings/ssh/SshPage'

const DEFAULT_PAGE = 'general'

/** Each page, given the detail of its route, such as a credential, SSH host or audit area. */
const PAGES: Record<Exclude<SettingsPageKey, ProbedPageKey>, (detail: string | null) => ReactElement> = {
  general: () => <GeneralPage />,
  agents: () => <AgentsPage />,
  notifications: () => <NotificationsPage />,
  repos: () => <ReposPage />,
  ea: () => <EaPage />,
  resources: () => <ResourcesPage />,
  channels: () => <ChannelsPage />,
  about: () => <AboutPage />,
  account: () => <AccountPage />,
  signin: () => <SignInPage />,
  sandbox: () => <SandboxPage />,
  permissions: () => <PermissionsPage />,
  connections: (detail) => <ConnectionsPage connectionId={detail} />,
  credentials: (detail) => <CredentialSetsPage setId={detail} />,
  ssh: (detail) => <SshPage detail={detail} />,
  sharing: () => <SharingPage />,
  audit: (detail) => <AuditPage area={detail} />,
  mods: (detail) => <ModsPage detail={detail} />,
}

const isCorePage = (page: string): page is Exclude<SettingsPageKey, ProbedPageKey> => Object.hasOwn(PAGES, page)

/** Seti's pages from the table above, a mod's from the view it registered. */
function pageFor(page: string, detail: string | null): ReactElement | null {
  if (isProbedPage(page)) {
    return <CapabilitiesPages page={page} />
  }
  if (isCorePage(page)) {
    return PAGES[page](detail)
  }
  const View = settingsPages.get(page)?.view
  return View === undefined ? null : <View page={page} detail={detail} />
}

/** Settings pages in groups: a sidebar beside the page on desktop, a list of its own on phones. */
function SettingsNav({ selected, opened, nested }: { selected: string; opened: boolean; nested: boolean }) {
  const narrow = useNarrow()
  const shown = opened || !narrow
  const news = useNewsPages()
  const newsId = useId()
  const groups = useSettingsGroups()
  return (
    <nav aria-label="Settings pages" className="min-h-0 flex-1 overflow-y-auto pb-2">
      {groups.map((group) => (
        <div key={group.group} role="group" aria-label={group.group}>
          <div className="px-3 pt-3 pb-1 text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
            {group.group}
          </div>
          {group.pages.map((page) => {
            const Icon = page.icon
            const current = shown && page.key === selected
            const dot = news.includes(page.key)
            return (
              <button
                key={page.key}
                type="button"
                aria-current={current ? 'page' : undefined}
                aria-describedby={dot ? newsId : undefined}
                onClick={() => {
                  if (!current || !opened || nested) {
                    navigate('settings', page.key)
                  }
                }}
                className={cn(
                  'flex min-h-8 w-full items-center gap-2.5 px-3 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset max-md:min-h-11',
                  current && 'bg-accent font-medium',
                )}
              >
                <Icon className={cn('size-4 shrink-0 text-muted-foreground', current && 'text-foreground')} />
                <span className="min-w-0 flex-1 truncate">{page.label}</span>
                {dot && <NewsDot id={newsId} />}
                <ChevronRight className="size-4 shrink-0 text-muted-foreground md:hidden" />
              </button>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

export function SettingsPanel({ page, detail }: { page: string | null; detail: string | null }) {
  useSyncExternalStore(settingsPages.subscribe, settingsPages.list)
  const opened = page !== null
  const selected = isSettingsPage(page) ? page : DEFAULT_PAGE
  return (
    <div className="flex h-full min-h-0">
      <ListPane detailOpen={opened} pane={PANES.settings} label="Resize settings list" className="bg-card">
        <div className="flex h-10 shrink-0 items-center border-b border-border px-3">
          <h1 className="text-sm font-semibold">Settings</h1>
        </div>
        <SettingsNav selected={selected} opened={opened} nested={detail !== null} />
      </ListPane>
      <DetailPane detailOpen={opened}>{pageFor(selected, detail)}</DetailPane>
    </div>
  )
}
