import { CircleQuestionMark, PanelLeft, Plus, RefreshCw, Search, Webhook } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { DemoNotice } from '@/components/DemoNotice'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { FailureToasts } from '@/components/FailureToasts'
import { HeaderViews } from '@/components/HeaderViews'
import { InputHookOverlays } from '@/components/InputHookOverlays'
import { NavDrawer } from '@/components/NavDrawer'
import { Sidebar } from '@/components/Sidebar'
import { TurnNotices } from '@/components/TurnNotices'
import { Wordmark } from '@/components/Wordmark'
import { EaReplyToasts } from '@/components/ea/EaReplyToasts'
import { BisectBar } from '@/components/mods/BisectBar'
import { ModAskToasts } from '@/components/mods/ModAskToasts'
import { CommandPalette } from '@/components/palette/CommandPalette'
import { openPalette } from '@/components/palette/palette-store'
import { useCommands } from '@/components/palette/useCommands'
import { ShortcutGuideSheet } from '@/components/shortcuts/ShortcutGuide'
import { chordLabel, CHORDS, sectionChord, useChords } from '@/components/shortcuts/chords'
import { openGuide } from '@/components/shortcuts/guide-store'
import { armLanding, useFocusLanding } from '@/components/shortcuts/landing'
import { StatusBar } from '@/components/status-bar/StatusBar'
import { TeamChatPanel } from '@/components/team/TeamChatPanel'
import { TeamChatToggle } from '@/components/team/TeamChatToggle'
import { useThemeSync } from '@/components/theme/theme-choice'
import { Button } from '@/components/ui/button'
import { useAppHeight } from '@/hooks/useAppHeight'
import { useNarrow } from '@/hooks/useMedia'
import { useTypingMode } from '@/hooks/useTypingMode'
import { useWindowControlsOverlay } from '@/hooks/useWindowControlsOverlay'
import { useInputHookKeys } from '@/lib/input-hooks'
import { openNeedsYouShortcut } from '@/lib/needs-you'
import { PANEL } from '@/lib/panels'
import { refreshAllPolled } from '@/lib/polled'
import { navigate, parseHash, redirectMovedHash, takeFilesLink, type Route } from '@/lib/route'
import { digitSections, sectionLabel, sectionRegistry, type SectionKey } from '@/lib/sections'
import { openStartPage } from '@/lib/start-context'
import { ModViewSheet } from '@/mods/ModViewSheet'
import { useModHost } from '@/mods/useModHost'
import { requestEaSettings } from '@/panels/ea/ea-settings-store'
import { holdForTask } from '@/panels/files/open-in-task'
import { useSettingsGroups } from '@/panels/settings/pages'
import { useActiveLayout } from '@/panels/tasks/agents-layouts'
import { useOwnStepChords } from '@/panels/tasks/own-steps'
import { useNextUnseen } from '@/panels/tasks/useNextUnseen'
import { WorkspaceCommands } from '@/panels/tasks/workspaces/WorkspaceCommands'
import { TerminalCommands, TerminalNavButton } from '@/panels/terminal/TerminalNavButton'

const HomePanel = lazy(async () => import('@/panels/HomePanel').then((m) => ({ default: m.HomePanel })))
const EaPanel = lazy(async () => import('@/panels/EaPanel').then((m) => ({ default: m.EaPanel })))
const TasksPanel = lazy(async () => import('@/panels/TasksPanel').then((m) => ({ default: m.TasksPanel })))
const QuestionsPage = lazy(async () =>
  import('@/panels/questions/QuestionsPage').then((m) => ({ default: m.QuestionsPage })),
)
const ContextPanel = lazy(async () => import('@/panels/ContextPanel').then((m) => ({ default: m.ContextPanel })))
const SettingsPanel = lazy(async () => import('@/panels/SettingsPanel').then((m) => ({ default: m.SettingsPanel })))

/** Seti's sections from their lazy panels, a mod's from the view its UI half registered. */
function panelFor(route: Route): ReactNode {
  const panels: Partial<Record<SectionKey, () => ReactNode>> = {
    ea: () => <EaPanel />,
    home: () => <HomePanel />,
    agents: () => <TasksPanel selectedId={route.id} subId={route.sub} terminalId={route.terminal} />,
    questions: () => <QuestionsPage />,
    context: () => <ContextPanel selectedId={route.id} />,
    settings: () => <SettingsPanel page={route.id} detail={route.detail} />,
  }
  const View = sectionRegistry.get(route.section)?.view
  return panels[route.section]?.() ?? (View === undefined ? null : <View id={route.id} />)
}

const SIDEBAR_KEY = 'seti.sidebar.hidden'

function storedSidebarHidden(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1'
  } catch {
    return false
  }
}

/** The sidebar rail on wide screens, which the palette can hide; the menu drawer on narrow ones. */
function useSidebar(narrow: boolean) {
  const [hidden, setHidden] = useState(storedSidebarHidden)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const toggle = () => {
    if (narrow) {
      setDrawerOpen((open) => !open)
      return
    }
    const next = !hidden
    setHidden(next)
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0')
    } catch {
      // Storage can be blocked; the choice then lasts for this visit only.
    }
  }
  return { hidden: !narrow && hidden, drawerOpen, setDrawerOpen, toggle }
}

const settingsCommands = (groups: ReturnType<typeof useSettingsGroups>) =>
  groups.flatMap((group) =>
    group.pages.map((page) => ({
      id: `settings.${page.key}`,
      title: `Settings: ${page.label}`,
      icon: page.icon,
      group: 'Settings' as const,
      keywords: page.keywords === undefined ? group.group : `${group.group} ${page.keywords}`,
      run: () => {
        navigate('settings', page.key)
      },
    })),
  )

const SECTION_BINDINGS = digitSections().map((item) => ({
  chord: sectionChord(item.digit),
  run: () => {
    navigate(item.key)
  },
}))

/** Alt with a section's digit opens it, Alt+N the start page; the guide lists them. */
const APP_BINDINGS = [
  ...SECTION_BINDINGS,
  {
    chord: CHORDS.newAgent,
    run: () => {
      openStartPage()
    },
  },
]

function useShellCommands(toggleSidebar: () => void): void {
  const settings = useSettingsGroups()
  useChords(APP_BINDINGS)
  useOwnStepChords()
  useCommands([
    {
      id: 'agent.new',
      title: 'New agent',
      icon: Plus,
      group: 'General',
      keywords: 'start create task',
      shortcut: chordLabel(CHORDS.newAgent),
      run: () => {
        openStartPage()
      },
    },
    {
      id: 'ea.channels',
      title: 'EA channels',
      icon: Webhook,
      group: 'General',
      keywords: 'executive assistant settings subscriptions webhooks pollers inbox notifications',
      run: () => {
        navigate('ea')
        requestEaSettings()
      },
    },
    {
      id: 'view.sidebar',
      title: 'Toggle sidebar',
      icon: PanelLeft,
      group: 'View',
      keywords: 'hide show menu navigation',
      run: toggleSidebar,
    },
    {
      id: 'view.shortcuts',
      title: 'Keyboard shortcuts',
      icon: CircleQuestionMark,
      group: 'View',
      keywords: 'keys help guide hotkeys',
      shortcut: chordLabel(CHORDS.guide),
      run: openGuide,
    },
    {
      id: 'data.reload',
      title: 'Reload data',
      icon: RefreshCw,
      group: 'General',
      keywords: 'refresh fetch',
      run: refreshAllPolled,
    },
    ...settingsCommands(settings),
  ])
}

/** Settles the hash: moves old section hashes, and hands a Files deep link to its agent. */
function settleHash(): Route {
  redirectMovedHash()
  const link = takeFilesLink()
  if (link !== null) {
    holdForTask(link.task_id, { root: link.root, path: link.path, type: link.type })
  }
  return parseHash()
}

export function App() {
  const [route, setRoute] = useState<Route>(settleHash)
  useAppHeight()
  useTypingMode()
  const narrow = useNarrow()
  const sidebar = useSidebar(narrow)
  const main = useRef<HTMLElement>(null)
  useFocusLanding(main, 'page', route)
  useWindowControlsOverlay()
  useShellCommands(sidebar.toggle)
  useNextUnseen(route)
  useModHost()
  useInputHookKeys()
  useThemeSync()
  const chatOverLayout = useActiveLayout(narrow)?.overlay === true && route.section === 'agents'

  useEffect(openNeedsYouShortcut, [])

  useEffect(
    () =>
      sectionRegistry.subscribe(() => {
        setRoute((current) => {
          const next = parseHash()
          return next.section === current.section ? current : next
        })
      }),
    [],
  )

  useEffect(() => {
    const onHash = () => {
      armLanding('page')
      setRoute(settleHash())
    }
    window.addEventListener('hashchange', onHash)
    return () => {
      window.removeEventListener('hashchange', onHash)
    }
  }, [])

  const select = (section: SectionKey) => {
    navigate(section)
  }

  return (
    <div className="flex h-[var(--app-height,100dvh)] flex-col bg-background max-md:overflow-hidden pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] typing:pt-[env(safe-area-inset-top)] agent-room:pb-[env(safe-area-inset-bottom)]">
      <header
        data-slot="app-header"
        className="flex h-[calc(3rem+env(safe-area-inset-top))] shrink-0 items-center gap-6 border-b border-border bg-card px-4 pt-[env(safe-area-inset-top)] max-md:gap-3 typing:hidden"
      >
        <NavDrawer
          active={route.section}
          onSelect={select}
          open={sidebar.drawerOpen}
          onOpenChange={sidebar.setDrawerOpen}
        />
        <Wordmark />
        <HeaderViews />
        {narrow && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Search"
            className="text-muted-foreground"
            onClick={() => {
              openPalette()
            }}
          >
            <Search />
          </Button>
        )}
        {!narrow && sidebar.hidden && <TerminalNavButton />}
        {(narrow || sidebar.hidden) && <TeamChatToggle />}
      </header>
      <DemoNotice />
      <BisectBar />
      <div className="relative flex min-h-0 flex-1">
        {!narrow && !sidebar.hidden && <Sidebar active={route.section} onSelect={select} />}
        <main ref={main} {...PANEL} className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <ErrorBoundary name={sectionLabel(route.section)} resetKey={route.section}>
            <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading...</div>}>
              {panelFor(route)}
            </Suspense>
          </ErrorBoundary>
        </main>
        <TeamChatPanel overlay={chatOverLayout} />
      </div>
      <StatusBar />
      <CommandPalette route={route} />
      <WorkspaceCommands />
      <TerminalCommands />
      <FailureToasts openId={route.section === 'agents' ? route.id : null} />
      <TurnNotices route={route} />
      <EaReplyToasts />
      <ModAskToasts />
      <ModViewSheet />
      {(narrow || sidebar.hidden) && <ShortcutGuideSheet narrow={narrow} />}
      <InputHookOverlays />
    </div>
  )
}
