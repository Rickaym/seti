import type { AccessItem, AccessKind, AccessProfile } from '@seti/shared'
import {
  Blocks,
  BookOpen,
  CheckCheck,
  Cloud,
  Info,
  ListX,
  Puzzle,
  RotateCcw,
  SquareTerminal,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Hint } from '@/components/Hint'
import { SettingsLink } from '@/components/SettingsLink'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { useCoarsePointer } from '@/hooks/useMedia'
import { navigate } from '@/lib/route'
import { cn } from '@/lib/utils'
import { SourceMark } from '@/panels/access/SourceMark'
import { McpSessionNote } from './McpSessionNote'

interface Group {
  kind: AccessKind
  title: string
  icon: LucideIcon
  hint: string
  empty: ReactNode
}

/** A group's explanation: a tooltip, or on touch screens a popover that a tap opens. */
function About({ title, text }: { title: string; text: string }) {
  const coarse = useCoarsePointer()
  const button = (
    <button
      type="button"
      aria-label={`About ${title}`}
      className="relative hover:text-foreground pointer-coarse:after:absolute pointer-coarse:after:-inset-4"
    >
      <Info className="size-3" />
    </button>
  )
  if (!coarse) {
    return <Hint text={text}>{button}</Hint>
  }
  return (
    <Popover>
      <PopoverTrigger asChild>{button}</PopoverTrigger>
      <PopoverContent className="font-normal text-foreground">{text}</PopoverContent>
    </Popover>
  )
}

export const KIND_ICONS: Record<AccessKind, LucideIcon> = {
  ssh: SquareTerminal,
  aws: Cloud,
  mcp: Blocks,
  pack: BookOpen,
  plugin: Puzzle,
}

const GROUPS: readonly Group[] = [
  {
    kind: 'ssh',
    title: 'SSH hosts',
    icon: KIND_ICONS.ssh,
    hint: "Hosts from Settings, SSH, off for every agent unless a host's Default is on or the agent's credential bundles it. Turning a host on also lets ssh pass through its jump hosts.",
    empty: (
      <>
        No hosts yet; add them in <SettingsLink page="ssh">Settings, SSH</SettingsLink>.
      </>
    ),
  },
  {
    kind: 'aws',
    title: 'AWS',
    icon: KIND_ICONS.aws,
    hint: "Short-lived keys for the role in the agent's credential. Picking a credential with a role turns it on. Unsandboxed agents use this machine's own AWS instead.",
    empty: '',
  },
  {
    kind: 'mcp',
    title: 'MCP servers',
    icon: KIND_ICONS.mcp,
    hint: "Servers the agent's sessions load; each is on by default unless Settings, MCP servers turns it off.",
    empty: (
      <>
        No MCP servers yet; add them in <SettingsLink page="mcp">Settings, MCP servers</SettingsLink>.
      </>
    ),
  },
  {
    kind: 'pack',
    title: 'Context packs',
    icon: KIND_ICONS.pack,
    hint: "Reference material in the agent's prompt; a pack's Default under Context links it to every agent. Roles are picked under Role in the agent's settings.",
    empty: 'No context packs yet.',
  },
  {
    kind: 'plugin',
    title: 'Plugins',
    icon: KIND_ICONS.plugin,
    hint: "Seti plugins loaded into the agent's sessions; their Default is in Settings, Plugins.",
    empty: (
      <>
        No Seti plugins yet; add them in <SettingsLink page="plugins">Settings, Plugins</SettingsLink>.
      </>
    ),
  },
]

const matches = (item: AccessItem, query: string) => `${item.name} ${item.detail ?? ''}`.toLowerCase().includes(query)

const onOff = (on: boolean) => (on ? 'on' : 'off')

function sourceHint(item: AccessItem): string {
  if (item.override === null) {
    return `Inherited: ${onOff(item.default_enabled)} for every agent without its own choice.`
  }
  return `This agent's own choice; agents inherit ${onOff(item.default_enabled)}.`
}

/** An enabled host that cannot connect: it, or a jump host on its way, has no key yet. */
function MissingKey({ item }: { item: AccessItem }) {
  const [first] = item.missing_key
  if (!item.enabled || first === undefined) {
    return null
  }
  return (
    <div className="flex min-w-0 items-center gap-1 text-2xs text-destructive">
      <TriangleAlert className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{first === item.id ? 'No key' : `Jump host ${first} has no key`}</span>
      <button
        type="button"
        className="shrink-0 underline underline-offset-2 hover:text-foreground"
        onClick={() => {
          navigate('settings', `ssh/${first}`)
        }}
      >
        Open {first}
      </button>
    </div>
  )
}

/** Why a host the agent's credential bundles stays on, or null. */
const setLock = (item: AccessItem, profile: AccessProfile | null) =>
  item.in_set ? `Comes with ${profile?.name ?? 'its credential'}; change it in Settings, Credentials` : null

/** The lines under an item's name: where it goes, how it is passed or granted, what is missing. */
function RowNotes({ item, profile }: { item: AccessItem; profile: AccessProfile | null }) {
  const jumpNote =
    !item.enabled && item.jump_for.length > 0 ? `Passed through as the jump host of ${item.jump_for.join(', ')}` : null
  return (
    <>
      {item.detail !== null && <div className="truncate text-2xs text-muted-foreground">{item.detail}</div>}
      {jumpNote !== null && <div className="truncate text-2xs text-muted-foreground">{jumpNote}</div>}
      {item.in_set && (
        <div className="truncate text-2xs text-muted-foreground">From {profile?.name ?? 'its credential'}</div>
      )}
      <MissingKey item={item} />
    </>
  )
}

/** Two columns from md up: a right divider on the left column, none under the last row. */
const TWO_COLUMN_ROW = 'md:odd:border-r md:[&:nth-last-child(2):nth-child(odd)]:border-b-0'

function Row({
  item,
  busy,
  locked,
  profile,
  plain,
  columns,
  onChange,
  onSignIn,
}: {
  item: AccessItem
  busy: boolean
  locked: string | null
  profile: AccessProfile | null
  plain: boolean
  columns: 1 | 2
  onChange: (item: AccessItem, enabled: boolean | null) => void
  onSignIn?: (item: AccessItem) => void
}) {
  const lock = locked ?? setLock(item, profile)
  const control = (
    <Switch
      aria-label={item.name}
      checked={item.enabled}
      disabled={busy || lock !== null}
      onCheckedChange={(enabled) => {
        onChange(item, enabled)
      }}
    />
  )
  return (
    <li
      className={cn(
        'flex min-w-0 items-center gap-2 border-b border-border px-2.5 py-1.5 last:border-b-0',
        columns === 2 && TWO_COLUMN_ROW,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{item.name}</div>
        <RowNotes item={item} profile={profile} />
        <McpSessionNote item={item} {...(onSignIn === undefined ? {} : { onSignIn })} />
      </div>
      {!plain && <SourceMark custom={item.override !== null} hint={sourceHint(item)} />}
      {!plain && item.override !== null && lock === null && (
        <Hint text={`Back to the default: ${onOff(item.default_enabled)}`}>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Reset ${item.name} to default`}
            disabled={busy}
            onClick={() => {
              onChange(item, null)
            }}
          >
            <RotateCcw />
          </Button>
        </Hint>
      )}
      {lock === null ? (
        control
      ) : (
        <Hint text={lock}>
          <span>{control}</span>
        </Hint>
      )}
    </li>
  )
}

function BulkButtons({
  title,
  rows,
  frozen,
  onSetAll,
}: {
  title: string
  rows: readonly AccessItem[]
  frozen: boolean
  onSetAll: (items: readonly AccessItem[], enabled: boolean) => void
}) {
  const button = 'h-6 gap-1 px-1.5 text-2xs font-normal pointer-coarse:h-11'
  return (
    <span className="ml-auto flex shrink-0 items-center">
      <Button
        size="xs"
        variant="ghost"
        className={button}
        aria-label={`Select all ${title}`}
        disabled={frozen || rows.every((item) => item.enabled)}
        onClick={() => {
          onSetAll(rows, true)
        }}
      >
        <CheckCheck />
        All
      </Button>
      <Button
        size="xs"
        variant="ghost"
        className={button}
        aria-label={`Clear all ${title}`}
        disabled={frozen || rows.every((item) => !item.enabled)}
        onClick={() => {
          onSetAll(rows, false)
        }}
      >
        <ListX />
        Clear
      </Button>
    </span>
  )
}

/**
 * What an agent may reach, grouped: each item's state for this agent, whether it follows the
 * default or the agent's own choice, a switch and a reset to the default.
 */
export function AccessList({
  items,
  onChange,
  kinds = GROUPS.map((group) => group.kind),
  query = '',
  busy = null,
  locked = () => null,
  profile = null,
  plain = false,
  hints = {},
  columns = 1,
  frozen = false,
  onSetAll,
  onSignIn,
}: {
  items: readonly AccessItem[]
  onChange: (item: AccessItem, enabled: boolean | null) => void
  kinds?: readonly AccessKind[]
  /** Shows only items whose name or detail contains it, or whole groups whose title does. */
  query?: string
  /** The kind and id of the item being saved. */
  busy?: string | null
  /** Why an item cannot change here, or null when it can. */
  locked?: (item: AccessItem) => string | null
  /** The agent's credentials, which may bundle ssh hosts. */
  profile?: AccessProfile | null
  /** For the EA, which follows no defaults: no Inherited or Custom marks and no reset. */
  plain?: boolean
  /** Group hints in place of the ones written for agents. */
  hints?: Partial<Record<AccessKind, string>>
  /** Two lays each group out in two columns from md up, for a wide dialog. */
  columns?: 1 | 2
  /** A bulk change is saving: every switch and bulk button waits for it. */
  frozen?: boolean
  /** Turns every shown item of a group on or off; without it the groups have no bulk buttons. */
  onSetAll?: (items: readonly AccessItem[], enabled: boolean) => void
  /** Opens the OAuth sign-in of an MCP server its latest session could not reach. */
  onSignIn?: (item: AccessItem) => void
}) {
  const needle = query.trim().toLowerCase()
  const groups = GROUPS.filter((group) => kinds.includes(group.kind)).flatMap((group) => {
    const all = items.filter((item) => item.kind === group.kind)
    if (needle === '') {
      return all.length === 0 && group.empty === '' ? [] : [{ group, all, rows: all }]
    }
    const rows = group.title.toLowerCase().includes(needle) ? all : all.filter((item) => matches(item, needle))
    return rows.length === 0 ? [] : [{ group, all, rows }]
  })
  if (groups.length === 0) {
    return <p className="py-2 text-xs text-muted-foreground">Nothing matches &quot;{query.trim()}&quot;.</p>
  }
  return (
    <div className="flex min-w-0 flex-col gap-3 text-xs">
      {groups.map(({ group, all, rows }) => {
        const Icon = group.icon
        const on = all.filter((item) => item.enabled).length
        const free = rows.filter((item) => locked(item) === null)
        return (
          <section key={group.kind} aria-label={group.title} className="flex min-w-0 flex-col gap-1">
            <h4 className="flex items-center gap-1.5 text-2xs font-medium text-muted-foreground">
              <Icon className="size-3.5" aria-hidden />
              {group.title}
              {all.length > 0 && (
                <span className="font-normal tabular-nums">{`${String(on)}/${String(all.length)} on`}</span>
              )}
              <About title={group.title} text={hints[group.kind] ?? group.hint} />
              {onSetAll !== undefined && free.length > 1 && (
                <BulkButtons title={group.title} rows={free} frozen={frozen} onSetAll={onSetAll} />
              )}
            </h4>
            {rows.length === 0 ? (
              <p className="text-muted-foreground">{group.empty}</p>
            ) : (
              <ul
                className={cn('min-w-0 border border-input', columns === 2 && 'grid md:grid-cols-2')}
                aria-label={group.title}
              >
                {rows.map((item) => (
                  <Row
                    key={item.id}
                    item={item}
                    busy={frozen || busy === `${item.kind}:${item.id}`}
                    locked={locked(item)}
                    profile={profile}
                    plain={plain}
                    columns={columns}
                    onChange={onChange}
                    {...(onSignIn === undefined ? {} : { onSignIn })}
                  />
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}
