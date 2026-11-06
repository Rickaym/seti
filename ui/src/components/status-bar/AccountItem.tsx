import type { AccountHealthState, AccountStatus, UsageWindow } from '@seti/shared'
import { Check, KeyRound, Save, Settings, UserRound, UserRoundX, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  clockTime,
  planName,
  usageLines,
  usageMeter,
  usageWords,
  type Level,
  type UsageFill,
  type UsageMeter,
} from '@/components/account/format'
import { setLoginMenu, useLoginMenu } from '@/components/account/login-menu'
import { useLoginSwitching } from '@/components/account/useLoginSwitching'
import { chordLabel, CHORDS } from '@/components/shortcuts/chords'
import { ItemHint, StatusBarItem } from '@/components/status-bar/StatusBarItem'
import type { StatusTone } from '@/components/status-bar/tone'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { activeLogin, switchLogin, useAccount } from '@/hooks/useAccount'
import { navigate } from '@/lib/route'
import { cn } from '@/lib/utils'

const ICON: Record<AccountHealthState, LucideIcon> = {
  ok: UserRound,
  api_key: KeyRound,
  logged_out: UserRoundX,
  error: UserRoundX,
}

function tone(state: AccountHealthState): StatusTone {
  switch (state) {
    case 'logged_out':
    case 'error':
      return 'danger'
    case 'api_key':
      return 'warning'
    case 'ok':
      return 'default'
  }
}

const FILL: Record<Level, string> = {
  normal: 'bg-foreground/60',
  warning: 'bg-warning-fill',
  danger: 'bg-destructive',
}

const BAR = 'relative h-1.5 w-10 overflow-hidden bg-foreground/15'
const width = (fill: UsageFill) => `${String(fill.percent)}%`

function WindowBar({ window: w, fill }: { window: UsageWindow; fill: UsageFill }) {
  return (
    <span
      className={BAR}
      data-testid="usage-bar"
      data-window={w.key}
      data-level={fill.level}
      data-percent={Math.round(fill.percent)}
    >
      <span className={cn('absolute inset-y-0 left-0', FILL[fill.level])} style={{ width: width(fill) }} />
    </span>
  )
}

function MeterBar({ meter }: { meter: UsageMeter }) {
  const { primary, weekly, weeklyAbove } = meter
  return (
    <span
      className={BAR}
      data-testid="usage-bar"
      data-window="five_hour"
      data-level={primary?.level ?? 'normal'}
      data-percent={primary === null ? undefined : Math.round(primary.percent)}
    >
      {weekly && (
        <span
          className={cn('absolute inset-y-0 left-0 opacity-40', FILL[weekly.level])}
          style={{ width: width(weekly) }}
          data-testid="usage-weekly"
          data-level={weekly.level}
          data-percent={Math.round(weekly.percent)}
        />
      )}
      {primary && (
        <span
          className={cn('absolute inset-y-0 left-0', FILL[primary.level])}
          style={{ width: width(primary) }}
          data-testid="usage-primary"
        />
      )}
      {/* Under the bright fill the weekly level shows as a notch in the bar background. */}
      {weekly && weekly.percent > 0 && (
        <span
          className={cn('absolute inset-y-0 w-px', weeklyAbove ? FILL[weekly.level] : 'bg-muted')}
          style={{ left: `max(0px, calc(${width(weekly)} - 1px))` }}
          data-testid="usage-weekly-marker"
          data-position={weeklyAbove ? 'above' : 'under'}
        />
      )}
    </span>
  )
}

const STATE_WORDS: Record<AccountHealthState, string> = {
  ok: 'logged in',
  api_key: 'using an API key',
  logged_out: 'logged out',
  error: 'login unreadable',
}

const openSettings = () => {
  navigate('settings', 'account')
}

/** The saved logins, the one in use ticked; picking another switches Claude Code to it. */
function LoginMenu({ status, children }: { status: AccountStatus; children: ReactNode }) {
  const open = useLoginMenu()
  const { accounts, active_id: activeId, unsaved } = status.logins
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setLoginMenu}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="min-w-56">
        <p className="flex items-center justify-between gap-3 px-2.5 pt-1 pb-1.5 text-2xs text-muted-foreground">
          Claude login
          <kbd className="font-mono pointer-coarse:hidden">{chordLabel(CHORDS.switchLogin)}</kbd>
        </p>
        {accounts.map((login) => {
          const active = login.id === activeId
          return (
            <DropdownMenuItem
              key={login.id}
              aria-label={active ? `${login.name}, in use` : `Switch to ${login.name}`}
              data-active={active}
              onSelect={() => {
                if (!active) {
                  void switchLogin(login)
                }
              }}
            >
              <Check className={cn(!active && 'invisible')} />
              <span className="grid min-w-0 flex-1">
                <span className={cn('truncate', active && 'font-semibold')}>{login.name}</span>
                {login.email !== null && <span className="truncate text-2xs text-muted-foreground">{login.email}</span>}
              </span>
              {login.plan !== null && <DropdownMenuShortcut>{planName(login.plan)}</DropdownMenuShortcut>}
            </DropdownMenuItem>
          )
        })}
        {unsaved !== null && (
          <DropdownMenuItem onSelect={openSettings}>
            <Save />
            <span className="min-w-0 flex-1 truncate">Save {unsaved.email ?? 'current login'}</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={openSettings}>
          <Settings />
          Manage
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const ofLogin = (name: string | undefined) => (name === undefined ? '' : ` ${name}`)

function AccountHint({ status, switchable }: { status: AccountStatus; switchable: boolean }) {
  const { state, message } = status.health
  const lines = usageLines(state === 'ok' ? (status.usage?.windows ?? []) : [])
  const name = activeLogin(status.logins)?.name
  const usage = name === undefined ? 'Plan usage' : `Plan usage of ${name}`
  return (
    <ItemHint title={state === 'ok' ? usage : message}>
      {lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
      <span>
        Checked {clockTime(status.fetched_at)}. {switchable ? 'Click to switch logins.' : 'Click for details.'}
      </span>
    </ItemHint>
  )
}

/** The bar's face of the account: health icon, the login in use and its plan meters. */
function AccountBadge({ status }: { status: AccountStatus }) {
  const { state } = status.health
  const Icon = ICON[state]
  const meter = usageMeter(state === 'ok' ? (status.usage?.windows ?? []) : [])
  const login = activeLogin(status.logins)
  return (
    <>
      <Icon className="size-3" />
      {login !== null && (
        <span className="max-w-24 truncate" data-testid="active-login">
          {login.name}
        </span>
      )}
      {meter && (meter.primary !== null || meter.weekly !== null) && <MeterBar meter={meter} />}
      {meter?.hottest && <WindowBar window={meter.hottest.window} fill={meter.hottest.fill} />}
    </>
  )
}

function summaryOf(status: AccountStatus): string {
  const { state } = status.health
  const words = usageWords(state === 'ok' ? (status.usage?.windows ?? []) : [])
  return words === '' ? STATE_WORDS[state] : words
}

export function AccountItem() {
  const { data } = useAccount()
  useLoginSwitching(data?.logins)
  if (!data) {
    return null
  }
  const switchable = data.logins.accounts.length > 0
  const item = (
    <StatusBarItem
      label={`Claude account${ofLogin(activeLogin(data.logins)?.name)}: ${summaryOf(data)}`}
      name="Plan usage"
      tone={tone(data.health.state)}
      tooltip={<AccountHint status={data} switchable={switchable} />}
      onClick={switchable ? undefined : openSettings}
    >
      <AccountBadge status={data} />
    </StatusBarItem>
  )
  return switchable ? <LoginMenu status={data}>{item}</LoginMenu> : item
}
