import { everyWords, type ModContributions } from '@seti/shared'

interface ContributionItem {
  name: string
  detail: string | null
}

interface ContributionGroup {
  title: string
  items: ContributionItem[]
}

const listOf = (items: readonly string[]) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`

const COMMAND_PLACES: Readonly<Record<string, string>> = {
  palette: 'the command palette',
  agentHeader: "an agent's header",
  agents: 'agents',
  ea: 'the EA',
  view: 'its own views',
}

const VIEW_PLACES: Readonly<Record<string, string>> = {
  section: 'A section of its own',
  header: 'The band across the header',
  about: 'Settings, About',
  agentTab: "A tab in an agent's page",
  sidePanel: 'The side panel',
  agentsLayout: 'A layout of several agents',
}

const titled = (entries: readonly { title: string; description?: string | undefined }[]) =>
  entries.map((entry) => ({ name: entry.title, detail: entry.description ?? null }))

const named = (names: readonly string[]) => names.map((name) => ({ name, detail: null }))

const viewerDetail = (viewer: ModContributions['fileViewers'][number]) =>
  listOf([...viewer.extensions.map((extension) => `.${extension}`), ...viewer.kinds.map((kind) => `${kind} files`)])

/** Everything a mod adds to Seti, grouped as its Contributes tab lists it; empty groups left out. */
export function contributionGroups(contributes: ModContributions): ContributionGroup[] {
  const groups: ContributionGroup[] = [
    {
      title: 'Commands',
      items: contributes.commands.map((command) => ({
        name: command.title,
        detail: [
          command.description,
          `From ${listOf(command.for.map((place) => COMMAND_PLACES[place] ?? place))}.`,
          command.chord === undefined ? undefined : `Keys: ${command.chord}.`,
        ]
          .filter((part) => part !== undefined)
          .join(' '),
      })),
    },
    {
      title: 'Slash commands',
      items: contributes.slashCommands.map((slash) => ({
        name: `/${slash.name}`,
        detail: slash.description === '' ? null : slash.description,
      })),
    },
    {
      title: 'Views',
      items: contributes.views.map((view) => ({
        name: view.title,
        detail: `${VIEW_PLACES[view.where] ?? view.where}, ${view.phone ? 'on phones too' : 'on larger screens'}.`,
      })),
    },
    {
      title: 'File viewers',
      items: contributes.fileViewers.map((viewer) => ({
        name: viewer.title,
        detail: `Opens ${viewerDetail(viewer)}.`,
      })),
    },
    { title: 'Markdown fences', items: named(contributes.fenceRenderers.map((fence) => fence.language)) },
    { title: 'Status bar items', items: titled(contributes.statusBar) },
    {
      title: 'Channel sources',
      items: contributes.channelSources.map((source) => ({
        name: source.title,
        detail: `${source.kind === 'webhook' ? 'Webhook' : 'Poller'}: ${source.description}`,
      })),
    },
    { title: 'Themes', items: titled(contributes.themes) },
    { title: 'Notifications', items: titled(contributes.notifications) },
    { title: 'Agent instructions', items: titled(contributes.contextProviders) },
    {
      title: 'Keyboard',
      items: [
        ...titled(contributes.inputHooks),
        ...contributes.shortcuts.map((shortcut) => ({ name: shortcut.keys, detail: shortcut.title })),
      ],
    },
    { title: 'Pull requests', items: titled([...contributes.prDecorators, ...contributes.prChips]) },
    { title: 'Host proxies', items: titled(contributes.hostProxies) },
    { title: 'Stylesheets', items: named(contributes.styles.map((style) => style.file)) },
    {
      title: 'Schedules',
      items: contributes.schedules.map((schedule) => ({
        name: schedule.id,
        detail: `Runs ${everyWords(schedule.every)}.`,
      })),
    },
    { title: 'Agent events', items: named(contributes.taskEvents.map((event) => event.replace(/_/g, ' '))) },
    { title: 'Audit records', items: named(contributes.auditKinds) },
    {
      title: 'Routes',
      items: contributes.routes.map((route) => ({ name: `${route.method} ${route.path}`, detail: null })),
    },
  ]
  return groups.filter((group) => group.items.length > 0)
}
